// The Hub Durable Object (a single instance, "default") owns settings, the admin password and
// sessions, subscriptions and the notification log. It decides which Pollers run, receives every
// poll result, matches subscriptions, notifies (Telegram, Resend), answers bot commands and serves
// the SSE stream the WebUI listens to.
import { DurableObject } from "cloudflare:workers";
import { hashPassword, minPassLen, randomToken, sameSecret, sessionTTL, tokenHash, verifyPassword } from "./auth";
import { classify } from "./diff";
import * as labels from "./labels";
import type { EventFilter, PollStatus } from "./poller";
import { provider, providers, regionLabel } from "./providers";
import * as resend from "./resend";
import { iso } from "./stock";
import { broadcast, call, esc, formatAlert, telegramConfig } from "./telegram";
import { matches, targetKey, type Product, type StockEvent, type Subscription, type Target } from "./types";

const minInterval = 15;
const defaultInterval = 60;
const defaultCooldown = 600;

const schema = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_failures (ip TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, region TEXT NOT NULL, product_code TEXT NOT NULL,
    locations TEXT NOT NULL DEFAULT '[]', configs TEXT NOT NULL DEFAULT '[]', config_filter TEXT NOT NULL DEFAULT '',
    notify_on TEXT NOT NULL DEFAULT 'restock', enabled INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL DEFAULT '', event_id INTEGER, subscription_id INTEGER,
    channel TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS notifications_at ON notifications(at)`,
  // Cooldown bookkeeping: subscription|slot|kind → last notification time.
  `CREATE TABLE IF NOT EXISTS notified (ck TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  // Targets whose Poller has been told to run, so removed ones can be told to stop.
  `CREATE TABLE IF NOT EXISTS targets (target TEXT PRIMARY KEY, provider TEXT NOT NULL, region TEXT NOT NULL)`,
];

// Setting keys, shared with the Go version's internal/settings.
const K = {
  telegramToken: "telegram.token", telegramChatId: "telegram.chat_id", telegramCommands: "telegram.commands",
  resendApiKey: "resend.api_key", resendFrom: "resend.from", resendTo: "resend.to",
  interval: "monitor.interval", cooldown: "monitor.cooldown", targets: "monitor.targets",
  paused: "monitor.paused", retentionDays: "monitor.retention_days", passwordHash: "auth.password_hash",
  // Cloudflare-only: the Telegram webhook secret and what it was last registered for.
  webhookSecret: "telegram.webhook_secret", webhookState: "telegram.webhook_state", webhookError: "telegram.webhook_error",
} as const;

interface Values {
  telegramToken: string;
  telegramChatId: string;
  telegramCommands: boolean;
  resendApiKey: string;
  resendFrom: string;
  resendTo: string;
  interval: number; // seconds
  cooldown: number; // seconds
  targets: Target[];
  paused: boolean;
  retentionDays: number;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// RPC can't carry custom error classes, so failures cross the boundary as values.
export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

async function result<T>(f: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, status: e.status, error: e.message };
    throw e;
  }
}

const parseTargets = (s: string): Target[] =>
  s.split(",").map((p) => p.trim().split(":")).filter(([p, r]) => p && r).map(([provider, region]) => ({ provider, region }));

const secretHint = (s: string) => (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : "");

const secondsOr = (s: string | undefined, def: number) => (Number(s) > 0 ? Math.floor(Number(s)) : def);

export interface SubscriptionInput {
  provider?: string;
  region?: string;
  productCode?: string;
  locations?: string[] | null;
  configs?: string[] | null;
  configFilter?: string;
  notifyOn?: string;
  enabled?: boolean;
  note?: string;
}

type ApiEvent = Omit<StockEvent, "at"> & { at: string };
const apiEvent = (e: StockEvent): ApiEvent => ({ ...e, at: iso(e.at) });

export class Hub extends DurableObject<Env> {
  private sql: SqlStorage;
  private streams = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private pingTimer?: ReturnType<typeof setInterval>;
  private polls = new Map<string, PollStatus>(); // latest status reported by each Poller

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      for (const s of schema) this.sql.exec(s);
    });
  }

  private poller(t: Target) {
    return this.env.POLLER.get(this.env.POLLER.idFromName(targetKey(t)));
  }

  // --- settings ---

  private kv(): Map<string, string> {
    return new Map(this.sql.exec<{ key: string; value: string }>(`SELECT key, value FROM kv`).toArray().map((r) => [r.key, r.value]));
  }

  private kvSet(values: Record<string, string>) {
    for (const [k, v] of Object.entries(values)) {
      this.sql.exec(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, k, v);
    }
  }

  // Stored values with environment overrides applied (same rules as internal/settings).
  private settings(): Values {
    const m = this.kv(), e = this.env;
    return {
      telegramToken: e.TELEGRAM_TOKEN || m.get(K.telegramToken) || "",
      telegramChatId: e.TELEGRAM_CHAT_ID || m.get(K.telegramChatId) || "",
      telegramCommands: m.get(K.telegramCommands) !== "false",
      resendApiKey: e.RESEND_API_KEY || m.get(K.resendApiKey) || "",
      resendFrom: e.RESEND_FROM || m.get(K.resendFrom) || "",
      resendTo: e.RESEND_TO || m.get(K.resendTo) || "",
      interval: Math.max(secondsOr(m.get(K.interval), defaultInterval), minInterval),
      cooldown: secondsOr(m.get(K.cooldown), defaultCooldown),
      targets: m.has(K.targets) ? parseTargets(m.get(K.targets)!) : [{ provider: "ovh", region: "eu" }],
      paused: m.get(K.paused) === "true",
      retentionDays: secondsOr(m.get(K.retentionDays), 30),
    };
  }

  private settingsView() {
    const v = this.settings(), e = this.env;
    return {
      telegramTokenSet: !!v.telegramToken, telegramTokenHint: secretHint(v.telegramToken),
      telegramChatId: v.telegramChatId, telegramCommands: v.telegramCommands,
      resendKeySet: !!v.resendApiKey, resendKeyHint: secretHint(v.resendApiKey),
      resendFrom: v.resendFrom, resendTo: v.resendTo,
      interval: v.interval, cooldown: v.cooldown, targets: v.targets, paused: v.paused, retentionDays: v.retentionDays,
      envOverrides: {
        telegramToken: !!e.TELEGRAM_TOKEN, telegramChatId: !!e.TELEGRAM_CHAT_ID,
        resendApiKey: !!e.RESEND_API_KEY, resendFrom: !!e.RESEND_FROM, resendTo: !!e.RESEND_TO,
      },
    };
  }

  private telegram() {
    const v = this.settings();
    return telegramConfig(v.telegramToken, v.telegramChatId, this.env.TELEGRAM_API);
  }

  private resend() {
    const v = this.settings();
    return resend.resendConfig(v.resendApiKey, v.resendFrom, v.resendTo, this.env.RESEND_API);
  }

  // --- auth ---

  private async passwordHash(): Promise<string> {
    let h = this.kv().get(K.passwordHash) ?? "";
    if (!h && this.env.ADMIN_PASSWORD) {
      // First start: adopt ADMIN_PASSWORD (later changes happen in the WebUI).
      if (this.env.ADMIN_PASSWORD.length < minPassLen) throw new HttpError(500, `ADMIN_PASSWORD 至少 ${minPassLen} 位`);
      h = await hashPassword(this.env.ADMIN_PASSWORD);
      this.kvSet({ [K.passwordHash]: h });
    }
    return h;
  }

  private async newSession(): Promise<{ token: string; expires: number }> {
    const token = randomToken(32), expires = Date.now() + sessionTTL;
    this.sql.exec(`INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)`, await tokenHash(token), expires);
    return { token, expires };
  }

  // Per-IP throttling: 5 failures per 15 minutes.
  login(ip: string, pw: string) {
    return result(async () => {
      const cut = Date.now() - 15 * 60_000;
      this.sql.exec(`DELETE FROM login_failures WHERE at < ?`, cut);
      if (this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM login_failures WHERE ip = ?`, ip).one().n >= 5) {
        throw new HttpError(429, "尝试次数过多，请稍后再试");
      }
      const h = await this.passwordHash();
      if (!h) throw new HttpError(401, "未设置管理员密码：请用 wrangler secret put ADMIN_PASSWORD 设置初始密码");
      if (!(await verifyPassword(pw, h))) {
        this.sql.exec(`INSERT INTO login_failures (ip, at) VALUES (?, ?)`, ip, Date.now());
        throw new HttpError(401, "密码错误");
      }
      this.sql.exec(`DELETE FROM login_failures WHERE ip = ?`, ip);
      return this.newSession();
    });
  }

  async validSession(token: string): Promise<boolean> {
    if (!token) return false;
    return this.sql.exec(`SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?`, await tokenHash(token), Date.now()).toArray().length > 0;
  }

  async logout(token: string) {
    if (token) this.sql.exec(`DELETE FROM sessions WHERE token_hash = ?`, await tokenHash(token));
  }

  // Invalidates every session, then logs this browser back in.
  changePassword(current: string, next: string) {
    return result(async () => {
      if (!(await verifyPassword(current, await this.passwordHash()))) throw new HttpError(400, "当前密码错误");
      if (next.length < minPassLen) throw new HttpError(400, `密码至少 ${minPassLen} 位`);
      this.kvSet({ [K.passwordHash]: await hashPassword(next) });
      this.sql.exec(`DELETE FROM sessions`);
      return this.newSession();
    });
  }

  // --- targets ---

  private listSubs(): Subscription[] {
    return this.sql.exec<Record<string, string | number>>(`SELECT * FROM subscriptions ORDER BY id DESC`).toArray().map((r) => ({
      id: Number(r.id), provider: String(r.provider), region: String(r.region), productCode: String(r.product_code),
      locations: JSON.parse(String(r.locations)), configs: JSON.parse(String(r.configs)),
      configFilter: String(r.config_filter), notifyOn: r.notify_on === "all" ? "all" : "restock",
      enabled: r.enabled === 1, note: String(r.note), createdAt: Number(r.created_at),
    }));
  }

  // Configured targets plus any region referenced by an enabled subscription.
  private wantedTargets(): Target[] {
    const out = new Map<string, Target>();
    const add = (t: Target) => {
      if (provider(this.env, t.provider)?.regions.some((r) => r.id === t.region)) out.set(targetKey(t), { provider: t.provider, region: t.region });
    };
    this.settings().targets.forEach(add);
    for (const s of this.listSubs()) if (s.enabled) add(s);
    return [...out.values()];
  }

  private runningTargets(): Target[] {
    return this.sql.exec<{ provider: string; region: string }>(`SELECT provider, region FROM targets ORDER BY target`).toArray();
  }

  // Starts Pollers for wanted targets and stops the rest. configure() is idempotent, so wanted ones
  // are re-sent every time; that also re-arms a Poller whose alarm got lost.
  private async reconcile(): Promise<Target[]> {
    const want = this.wantedTargets();
    const v = this.settings();
    const cfg = { intervalMs: v.interval * 1000, retentionDays: v.retentionDays };
    const keys = new Set(want.map(targetKey));
    const stop = this.runningTargets().filter((t) => !keys.has(targetKey(t)));
    await Promise.all([...want.map((t) => this.poller(t).configure(t, cfg)), ...stop.map((t) => this.poller(t).configure(null))]);
    for (const t of stop) {
      this.sql.exec(`DELETE FROM targets WHERE target = ?`, targetKey(t));
      this.polls.delete(targetKey(t));
    }
    for (const t of want) this.sql.exec(`INSERT INTO targets (target, provider, region) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, targetKey(t), t.provider, t.region);
    return want;
  }

  private async pollStatuses(): Promise<PollStatus[]> {
    const targets = await this.reconcile();
    const all = await Promise.all(targets.map((t) => this.poller(t).status()));
    return all.filter((s): s is PollStatus => !!s);
  }

  // --- called by Pollers ---

  async onPoll(t: Target, status: PollStatus, events: StockEvent[], products: Record<string, Product>) {
    this.polls.set(targetKey(t), status);
    this.prune();
    if (events.length) {
      this.publish("events", events.map(apiEvent));
      await this.dispatch(t, events, products);
    }
    this.publish("poll", [...this.polls.values()].sort((a, b) => (targetKey(a.target) < targetKey(b.target) ? -1 : 1)));
  }

  private prune() {
    const now = Date.now(), m = this.kv();
    if (now - Number(m.get("last_prune") ?? 0) < 3600_000) return;
    this.sql.exec(`DELETE FROM notifications WHERE at < ?`, now - this.settings().retentionDays * 24 * 3600_000);
    this.sql.exec(`DELETE FROM notified WHERE at < ?`, now - 24 * 3600_000);
    this.sql.exec(`DELETE FROM sessions WHERE expires_at < ?`, now);
    this.sql.exec(`DELETE FROM login_failures WHERE at < ?`, now - 15 * 60_000);
    this.kvSet({ last_prune: String(now) });
  }

  private record(t: string, channel: string, error: string, eventId?: number, subId?: number) {
    this.sql.exec(`INSERT INTO notifications (target, event_id, subscription_id, channel, ok, error, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      t, eventId ?? null, subId ?? null, channel, error ? 0 : 1, error, Date.now());
  }

  private async dispatch(t: Target, events: StockEvent[], products: Record<string, Product>) {
    const v = this.settings();
    if (v.paused) return;
    const tg = this.telegram(), rs = this.resend();
    const now = Date.now();
    for (const sub of this.listSubs()) {
      if (!sub.enabled || sub.provider !== t.provider || sub.region !== t.region) continue;
      const matched: StockEvent[] = [];
      for (const e of events) {
        const kind = classify(e.from, e.to);
        if (kind === "none" || (kind === "soldout" && sub.notifyOn !== "all")) continue;
        if (!matches(sub, e)) continue;
        const ck = `${sub.id}|${e.key}|${kind}`;
        const last = this.sql.exec<{ at: number }>(`SELECT at FROM notified WHERE ck = ?`, ck).toArray()[0]?.at;
        if (last != null && now - last < v.cooldown * 1000) continue;
        this.sql.exec(`INSERT INTO notified (ck, at) VALUES (?, ?) ON CONFLICT(ck) DO UPDATE SET at = excluded.at`, ck, now);
        matched.push(e);
      }
      if (!matched.length) continue;
      matched.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : a.config < b.config ? -1 : 1));
      const alert = {
        subscription: sub, provider: provider(this.env, t.provider), regionLabel: regionLabel(this.env, t.provider, t.region),
        product: products[sub.productCode], events: matched,
      };
      const send = async (channel: string, f: () => Promise<void>) => {
        let error = "";
        try {
          await f();
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          console.warn("notify failed", channel, sub.id, error);
        }
        this.record(targetKey(t), channel, error, matched[0].id, sub.id);
      };
      if (tg) await send("telegram", () => broadcast(tg, formatAlert(alert)));
      if (rs) await send("resend", () => resend.notify(rs, alert));
    }
  }

  // --- SSE (/api/stream) ---

  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname !== "/api/stream") return new Response("not found", { status: 404 });
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter();
    this.streams.add(w);
    req.signal.addEventListener("abort", () => this.drop(w));
    this.write(w, "poll", await this.pollStatuses());
    // Comment pings keep proxies from closing idle streams and reveal dead clients.
    this.pingTimer ??= setInterval(() => {
      for (const s of this.streams) this.send(s, ": ping\n\n");
    }, 25_000);
    return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
  }

  private drop(w: WritableStreamDefaultWriter<Uint8Array>) {
    if (!this.streams.delete(w)) return;
    w.close().catch(() => {});
    if (!this.streams.size && this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private send(w: WritableStreamDefaultWriter<Uint8Array>, text: string) {
    w.write(new TextEncoder().encode(text)).catch(() => this.drop(w));
  }

  private write(w: WritableStreamDefaultWriter<Uint8Array>, type: string, data: unknown) {
    this.send(w, `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private publish(type: string, data: unknown) {
    for (const w of this.streams) this.write(w, type, data);
  }

  // --- API ---

  async overview(origin: string) {
    await this.syncWebhook(origin);
    const subs = this.listSubs();
    const enabled = subs.filter((s) => s.enabled);
    const byTarget = new Map<string, Subscription[]>();
    for (const s of enabled) byTarget.set(targetKey(s), [...(byTarget.get(targetKey(s)) ?? []), s]);
    const counts = new Map<number, { name: string; count: number; locations: string[] }>();
    await Promise.all([...byTarget.values()].map(async (ss) => {
      for (const c of await this.poller(ss[0]).inStockFor(ss)) counts.set(c.id, c);
    }));
    const polls = await this.pollStatuses();
    const running = this.runningTargets();
    const [recent, day] = await Promise.all([
      this.mergedEvents(running, { onlyRestock: true, limit: 15 }),
      Promise.all(running.map((t) => this.poller(t).restockCount(Date.now() - 24 * 3600_000))),
    ]);
    const v = this.settings();
    const tg = !!this.telegram();
    return {
      polls,
      subscriptions: subs.length,
      enabledSubscriptions: enabled.length,
      watched: enabled.map((s) => {
        const c = counts.get(s.id);
        return { ...this.apiSub(s), name: c?.name ?? s.productCode, inStock: c?.count ?? 0, locations: c?.locations ?? [] };
      }),
      recentRestocks: recent.map(apiEvent),
      restocks24h: day.reduce((a, b) => a + b, 0),
      paused: v.paused,
      telegramConfigured: tg,
      notifyConfigured: tg || !!this.resend(),
      interval: v.interval,
    };
  }

  private async mergedEvents(targets: Target[], f: EventFilter): Promise<StockEvent[]> {
    const lists = await Promise.all(targets.map((t) => this.poller(t).events(f)));
    return lists.flat().sort((a, b) => b.id! - a.id!).slice(0, f.limit);
  }

  // GET /api/events; provider/region narrow it to one Poller, otherwise Pollers are merged by id.
  async events(q: { provider?: string; region?: string; product?: string; key?: string; restock?: boolean; limit?: number; before?: number; days?: number }) {
    let targets = this.runningTargets();
    if (q.key) {
      const [p, r] = q.key.split("|");
      targets = [{ provider: p, region: r }];
    }
    if (q.provider) targets = targets.filter((t) => t.provider === q.provider);
    if (q.region) targets = targets.filter((t) => t.region === q.region);
    if (q.provider && q.region && !targets.length) targets = [{ provider: q.provider, region: q.region }];
    const limit = q.limit && q.limit > 0 && q.limit <= 1000 ? q.limit : 100;
    const evs = await this.mergedEvents(targets, {
      productCode: q.product, key: q.key, onlyRestock: q.restock, limit, beforeId: q.before,
      since: q.days && q.days > 0 ? Date.now() - q.days * 24 * 3600_000 : undefined,
    });
    return evs.map(apiEvent);
  }

  notifications(limit: number) {
    if (!(limit > 0 && limit <= 500)) limit = 50;
    return this.sql.exec<Record<string, string | number>>(`SELECT * FROM notifications ORDER BY id DESC LIMIT ?`, limit).toArray().map((n) => ({
      id: Number(n.id), eventId: Number(n.event_id ?? 0), subscriptionId: Number(n.subscription_id ?? 0),
      channel: String(n.channel), ok: n.ok === 1, error: String(n.error), at: iso(Number(n.at)),
    }));
  }

  private apiSub(s: Subscription) {
    return { ...s, createdAt: iso(s.createdAt) };
  }

  subscriptions() {
    return this.listSubs().map((s) => this.apiSub(s));
  }

  private normalize(s: SubscriptionInput) {
    const p = s.provider?.trim() ?? "", region = s.region?.trim() ?? "", productCode = s.productCode?.trim() ?? "";
    if (!p || !region || !productCode) throw new HttpError(400, "provider, region and productCode are required");
    const notifyOn = s.notifyOn || "restock";
    if (notifyOn !== "restock" && notifyOn !== "all") throw new HttpError(400, "notifyOn must be restock or all");
    const pv = provider(this.env, p);
    if (!pv) throw new HttpError(400, `unknown provider "${p}"`);
    if (!pv.regions.some((r) => r.id === region)) throw new HttpError(400, `unknown region "${region}" for provider ${p}`);
    return [p, region, productCode, JSON.stringify(s.locations ?? []), JSON.stringify(s.configs ?? []),
      s.configFilter?.trim() ?? "", notifyOn, s.enabled ? 1 : 0, s.note ?? ""] as const;
  }

  createSubscription(s: SubscriptionInput) {
    return result(async () => {
      const id = this.sql.exec<{ id: number }>(
        `INSERT INTO subscriptions (provider, region, product_code, locations, configs, config_filter, notify_on, enabled, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, ...this.normalize(s), Date.now()).one().id;
      await this.reconcile();
      return this.apiSub(this.listSubs().find((x) => x.id === id)!);
    });
  }

  updateSubscription(id: number, s: SubscriptionInput) {
    return result(async () => {
      const n = this.sql.exec(
        `UPDATE subscriptions SET provider = ?, region = ?, product_code = ?, locations = ?, configs = ?, config_filter = ?,
           notify_on = ?, enabled = ?, note = ? WHERE id = ?`, ...this.normalize(s), id).rowsWritten;
      if (!n) throw new HttpError(404, "subscription not found");
      await this.reconcile();
      return this.apiSub(this.listSubs().find((x) => x.id === id)!);
    });
  }

  deleteSubscription(id: number) {
    return result(async () => {
      if (!this.sql.exec(`DELETE FROM subscriptions WHERE id = ?`, id).rowsWritten) throw new HttpError(404, "subscription not found");
      await this.reconcile();
      return null;
    });
  }

  getSettings() {
    return this.settingsView();
  }

  putSettings(body: Record<string, unknown>, origin: string) {
    return result(async () => {
      const kv: Record<string, string> = {};
      const str = (k: string, key: string) => {
        if (typeof body[k] === "string") kv[key] = (body[k] as string).trim();
      };
      str("telegramToken", K.telegramToken);
      str("telegramChatId", K.telegramChatId);
      str("resendApiKey", K.resendApiKey);
      str("resendFrom", K.resendFrom);
      str("resendTo", K.resendTo);
      if (typeof body.telegramCommands === "boolean") kv[K.telegramCommands] = String(body.telegramCommands);
      if (typeof body.paused === "boolean") kv[K.paused] = String(body.paused);
      if (typeof body.interval === "number") {
        if (body.interval < minInterval) throw new HttpError(400, `轮询间隔不能小于 ${minInterval} 秒`);
        kv[K.interval] = String(Math.floor(body.interval));
      }
      if (typeof body.cooldown === "number") {
        if (body.cooldown < 0) throw new HttpError(400, "冷却时间不能为负");
        kv[K.cooldown] = String(Math.max(Math.floor(body.cooldown), 1));
      }
      if (typeof body.retentionDays === "number") {
        if (body.retentionDays < 1) throw new HttpError(400, "保留天数至少 1 天");
        kv[K.retentionDays] = String(Math.floor(body.retentionDays));
      }
      if (Array.isArray(body.targets)) {
        const ts = body.targets as Target[];
        for (const t of ts) {
          const pv = provider(this.env, t?.provider);
          if (!pv) throw new HttpError(400, `unknown provider "${t?.provider}"`);
          if (!pv.regions.some((r) => r.id === t.region)) throw new HttpError(400, `unknown region ${t.provider}:${t.region}`);
        }
        kv[K.targets] = ts.map((t) => `${t.provider}:${t.region}`).join(",");
      }
      this.kvSet(kv);
      await this.reconcile();
      await this.syncWebhook(origin);
      return this.settingsView();
    });
  }

  testNotify(channel: string) {
    return result(async () => {
      let send: () => Promise<void>;
      if (channel === "telegram") {
        const tg = this.telegram();
        send = () => (tg ? broadcast(tg, "✅ <b>StockWatch</b> 测试消息：Telegram 通知配置成功。") : Promise.reject(new Error("telegram 未配置 token 或 chat_id")));
      } else if (channel === "resend") {
        const rs = this.resend();
        send = () => (rs ? resend.sendTest(rs) : Promise.reject(new Error("resend 未配置 API Key、发件人或收件人")));
      } else {
        throw new HttpError(400, "unknown channel " + channel);
      }
      let error = "";
      try {
        await send();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      this.record("", channel, error);
      if (error) throw new HttpError(502, error);
      return { ok: true };
    });
  }

  async pollNow() {
    const targets = await this.reconcile();
    await Promise.all(targets.map((t) => this.poller(t).pollNow()));
  }

  providers() {
    return providers(this.env).map((p) => ({ id: p.id, name: p.name, regions: p.regions }));
  }

  // --- Telegram webhook ---

  // Registers (or removes) this deployment's webhook whenever the token, the commands switch or the
  // public origin changes. Telegram only accepts HTTPS, so local dev just records why it was skipped.
  private async syncWebhook(origin: string) {
    const v = this.settings();
    const m = this.kv();
    const want = v.telegramToken && v.telegramCommands ? `${await tokenHash(v.telegramToken)}|${origin}` : v.telegramToken ? `off|${await tokenHash(v.telegramToken)}` : "";
    if (want === (m.get(K.webhookState) ?? "")) return;
    let error = "", retry = false;
    if (v.telegramToken) {
      const cfg = { token: v.telegramToken, apiBase: (this.env.TELEGRAM_API || "https://api.telegram.org").replace(/\/+$/, "") };
      try {
        if (!v.telegramCommands) {
          await call(cfg, "deleteWebhook", {});
        } else if (!origin.startsWith("https://")) {
          error = `Telegram Webhook 需要 HTTPS，当前地址 ${origin}，Bot 命令不可用`;
        } else {
          let secret = this.env.TELEGRAM_WEBHOOK_SECRET || m.get(K.webhookSecret);
          if (!secret) this.kvSet({ [K.webhookSecret]: (secret = randomToken(24)) });
          await call(cfg, "setWebhook", { url: `${origin}/telegram/webhook`, secret_token: secret, allowed_updates: ["message"] });
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        retry = true; // keep the old state so the next overview or settings save tries again
      }
    }
    if (error) console.warn("telegram webhook", error);
    this.kvSet({ [K.webhookError]: error, ...(retry ? {} : { [K.webhookState]: want }) });
  }

  async handleTelegram(secret: string, update: { message?: { chat?: { id?: number | string }; text?: string } }): Promise<boolean> {
    const stored = this.env.TELEGRAM_WEBHOOK_SECRET || this.kv().get(K.webhookSecret) || "";
    if (!stored || !sameSecret(secret, stored)) return false;
    const v = this.settings();
    const tg = this.telegram();
    const chat = String(update.message?.chat?.id ?? "");
    const text = update.message?.text?.trim() ?? "";
    // Only answer the configured chats.
    if (!v.telegramCommands || !tg || !tg.chats.includes(chat) || !text.startsWith("/")) return true;
    let reply: string;
    switch (text.split(/\s+/)[0].split("@")[0]) {
      case "/status":
        reply = await this.statusText();
        break;
      case "/subs":
        reply = this.subscriptionsText();
        break;
      case "/pause":
        this.kvSet({ [K.paused]: "true" });
        reply = "⏸ 已暂停通知";
        break;
      case "/resume":
        this.kvSet({ [K.paused]: "false" });
        reply = "▶️ 已恢复通知";
        break;
      default:
        reply = "可用命令：\n/status 当前有货的订阅\n/subs 订阅列表\n/pause 暂停通知\n/resume 恢复通知";
    }
    await broadcast({ ...tg, chats: [chat] }, reply);
    return true;
  }

  private async statusText(): Promise<string> {
    const subs = this.listSubs().filter((s) => s.enabled);
    const byTarget = new Map<string, Subscription[]>();
    for (const s of subs) byTarget.set(targetKey(s), [...(byTarget.get(targetKey(s)) ?? []), s]);
    const counts = new Map<number, { name: string; count: number; locations: string[] }>();
    await Promise.all([...byTarget.values()].map(async (ss) => {
      for (const c of await this.poller(ss[0]).inStockFor(ss)) counts.set(c.id, c);
    }));
    let b = "<b>当前库存</b>\n";
    for (const s of subs) {
      const c = counts.get(s.id) ?? { name: s.productCode, count: 0, locations: [] };
      b += c.count === 0
        ? `🔴 ${esc(c.name)} <code>${esc(s.productCode)}</code> 无货\n`
        : `🟢 ${esc(c.name)} <code>${esc(s.productCode)}</code> ${c.count} 个配置有货：${esc(labels.locations(c.locations))}\n`;
    }
    if (!subs.length) b += "暂无启用的订阅";
    if (this.settings().paused) b += "\n⏸ 通知已暂停";
    return b;
  }

  private subscriptionsText(): string {
    const subs = this.listSubs();
    if (!subs.length) return "暂无订阅，请在 WebUI 中添加。";
    let b = "<b>订阅列表</b>\n";
    for (const s of subs) {
      const locs = s.locations.length ? labels.locations(s.locations) : "全部机房";
      b += `${s.enabled ? "✅" : "⏸"} #${s.id} ${esc(regionLabel(this.env, s.provider, s.region))} <code>${esc(s.productCode)}</code> · ${esc(locs)}`;
      for (const c of s.configs) b += `\n　· ${esc(labels.config(c, s.productCode))}`;
      b += "\n";
    }
    return b;
  }
}

