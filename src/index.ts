// Worker entry: the /api the WebUI talks to (cookie login, SSE) in front of the Hub and Poller
// Durable Objects, the Telegram webhook, and the WebUI from Static Assets (wrangler.jsonc routes only
// /api/* and /telegram/* here).
import { cookieName } from "./auth";
import type { Result, SubscriptionInput } from "./hub";
import { probe } from "./ovh";

export { Hub } from "./hub";
export { Poller } from "./poller";

const noCache = { "Cache-Control": "no-cache, no-store, must-revalidate" };

const json = (v: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(v, { status, headers: { ...noCache, ...headers } });

const err = (status: number, error: string) => json({ error }, status);

const fromResult = <T>(r: Result<T>, status = 200) => (r.ok ? json(r.value, status) : err(r.status, r.error));

function sessionToken(req: Request): string {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === cookieName) return v.join("=");
  }
  return "";
}

function sessionCookie(url: URL, token: string, expires: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${cookieName}=${token}; Path=/; Expires=${new Date(expires).toUTCString()}; HttpOnly; SameSite=Strict${secure}`;
}

const clearCookie = `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;

async function body<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

const num = (s: string | null) => (s && Number.isFinite(Number(s)) ? Number(s) : undefined);

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const hub = env.HUB.get(env.HUB.idFromName("default"));
    const q = url.searchParams;
    const route = `${req.method} ${url.pathname}`;

    if (route === "POST /telegram/webhook") {
      const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      const update = await body<Parameters<typeof hub.handleTelegram>[1]>(req);
      if (!update) return new Response("bad request", { status: 400 });
      // The Hub checks the secret against the one it registered and sends the reply itself.
      return (await hub.handleTelegram(secret, update)) ? new Response("ok") : new Response("forbidden", { status: 403 });
    }
    if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });

    switch (route) {
      case "GET /api/health":
        return json({ ok: true, version: env.VERSION ?? "dev" });
      case "POST /api/auth/login": {
        const b = await body<{ password?: string }>(req);
        if (typeof b?.password !== "string") return err(400, "invalid body");
        const r = await hub.login(req.headers.get("CF-Connecting-IP") ?? "local", b.password);
        if (!r.ok) return err(r.status, r.error);
        return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(url, r.value.token, r.value.expires) });
      }
      case "POST /api/auth/logout":
        await hub.logout(sessionToken(req));
        return json({ ok: true }, 200, { "Set-Cookie": clearCookie });
      case "GET /api/auth/me":
        return json({ authenticated: await hub.validSession(sessionToken(req)), version: env.VERSION ?? "dev" });
    }

    if (!(await hub.validSession(sessionToken(req)))) return err(401, "unauthorized");
    // Block cross-site state-changing requests (defense in depth on top of SameSite cookies).
    const origin = req.headers.get("Origin");
    if (req.method !== "GET" && req.method !== "HEAD" && origin && origin !== url.origin) return err(403, "cross-origin request rejected");

    const poller = () => {
      const provider = q.get("provider"), region = q.get("region");
      if (!provider || !region) return null;
      return { target: { provider, region }, stub: env.POLLER.get(env.POLLER.idFromName(`${provider}/${region}`)) };
    };

    switch (route) {
      case "PUT /api/auth/password": {
        const b = await body<{ current?: string; new?: string }>(req);
        if (typeof b?.current !== "string" || typeof b.new !== "string") return err(400, "invalid body");
        const r = await hub.changePassword(b.current, b.new);
        if (!r.ok) return err(r.status, r.error);
        return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(url, r.value.token, r.value.expires) });
      }
      case "GET /api/providers":
        return json(await hub.providers());
      case "GET /api/overview":
        return json(await hub.overview(url.origin));
      case "GET /api/stock": {
        const p = poller();
        if (!p) return err(400, "provider and region are required");
        const [stock, poll] = await Promise.all([p.stub.stock(), p.stub.status()]);
        return json({ target: p.target, poll, ...stock });
      }
      case "GET /api/stock/detail": {
        const p = poller();
        if (!p) return err(400, "provider and region are required");
        const code = q.get("product") ?? "";
        return json({ target: p.target, code, ...(await p.stub.stockDetail(code)) });
      }
      case "GET /api/order": {
        const p = poller();
        if (!p) return err(400, "provider and region are required");
        const link = await p.stub.orderLink(q.get("product") ?? "", q.get("location") ?? "", q.get("config") ?? "");
        return link ? Response.redirect(link, 302) : err(404, "no order link for this product");
      }
      case "GET /api/subscriptions":
        return json(await hub.subscriptions());
      case "POST /api/subscriptions": {
        const b = await body<SubscriptionInput>(req);
        if (!b) return err(400, "invalid body");
        return fromResult(await hub.createSubscription(b), 201);
      }
      case "GET /api/events":
        return json(await hub.events({
          provider: q.get("provider") ?? undefined, region: q.get("region") ?? undefined, product: q.get("product") ?? undefined,
          key: q.get("key") ?? undefined, restock: q.get("restock") === "1", limit: num(q.get("limit")), before: num(q.get("before")), days: num(q.get("days")),
        }));
      case "GET /api/notifications":
        return json(await hub.notifications(num(q.get("limit")) ?? 50));
      case "GET /api/settings":
        return json(await hub.getSettings());
      case "PUT /api/settings": {
        const b = await body<Record<string, unknown>>(req);
        if (!b || typeof b !== "object") return err(400, "invalid body");
        return fromResult(await hub.putSettings(b, url.origin));
      }
      case "POST /api/notify/test":
        return fromResult(await hub.testNotify(q.get("channel") || "telegram"));
      case "POST /api/poll":
        await hub.pollNow();
        return json({ ok: true }, 202);
      case "GET /api/stream":
        return hub.fetch(req);
      case "GET /api/probe":
        // Fetches OVH directly from this Worker: answers "does OVH accept Cloudflare's egress IPs?".
        return json(await Promise.all((q.get("regions") ?? "eu,ca,us").split(",").map((r) => probe(r.trim()))));
    }

    const sub = /^\/api\/subscriptions\/(\d+)$/.exec(url.pathname);
    if (sub && req.method === "PUT") {
      const b = await body<SubscriptionInput>(req);
      if (!b) return err(400, "invalid body");
      return fromResult(await hub.updateSubscription(Number(sub[1]), b));
    }
    if (sub && req.method === "DELETE") {
      const r = await hub.deleteSubscription(Number(sub[1]));
      return r.ok ? new Response(null, { status: 204 }) : err(r.status, r.error);
    }
    return err(404, "not found");
  },
} satisfies ExportedHandler<Env>;
