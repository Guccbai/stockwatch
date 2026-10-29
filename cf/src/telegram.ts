// Telegram Bot API: alert formatting and sending. Port of internal/notify/telegram, with the
// getUpdates long-poll replaced by a webhook (Workers can't hold a long-running loop).
import * as labels from "./labels";
import { inStock, type Product, type Provider, type StockEvent, type Subscription } from "./types";

const maxLines = 25;

export interface TelegramConfig {
  token: string;
  chats: string[];
  apiBase: string;
}

export function telegramConfig(token: string, chatIds: string, apiBase?: string): TelegramConfig | null {
  const chats = chatIds.split(",").map((c) => c.trim()).filter(Boolean);
  if (!token || chats.length === 0) return null;
  return { token, chats, apiBase: (apiBase || "https://api.telegram.org").replace(/\/+$/, "") };
}

export async function call(cfg: Pick<TelegramConfig, "token" | "apiBase">, method: string, payload: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${cfg.apiBase}/bot${cfg.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    let r: { ok: boolean; description?: string; result?: unknown; parameters?: { retry_after?: number } };
    try {
      r = await resp.json();
    } catch {
      throw new Error(`${method}: ${resp.status}`);
    }
    if (r.ok) return r.result;
    const retry = r.parameters?.retry_after ?? 0;
    if (retry > 0 && attempt < 2) {
      await new Promise((ok) => setTimeout(ok, retry * 1000));
      continue;
    }
    throw new Error(`${method}: ${r.description ?? resp.status}`);
  }
}

export async function broadcast(cfg: TelegramConfig, text: string): Promise<void> {
  const errs: string[] = [];
  for (const chat of cfg.chats) {
    try {
      await call(cfg, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true });
    } catch (e) {
      errs.push(`chat ${chat}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (errs.length) throw new Error(errs.join("; "));
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;");

function deliveryLabel(raw: string): string {
  if (raw === "1H-high") return "1 小时内交付";
  if (raw === "1H-low") return "1 小时内交付（库存紧张）";
  if (raw.endsWith("H")) return `${raw.slice(0, -1)} 小时内交付`;
  return raw;
}

// The transitions of one poll that matched one subscription.
export interface Alert {
  subscription: Subscription;
  provider?: Provider; // for per-configuration prices and pre-filled order links
  regionLabel: string;
  product?: Product; // missing when the product isn't in the catalog
  events: StockEvent[];
}

// Renders an alert as Telegram HTML.
export function formatAlert(a: Alert): string {
  const p = a.product;
  let orderUrl = p?.orderUrl ?? ""; // pre-filled order for the first restocked slot, else the product page
  let linked = false;
  const restock: string[] = [], soldout: string[] = [];
  for (const e of a.events) {
    let line = `• <b>${esc(labels.location(e.location))}</b> ${esc(labels.config(e.config, e.productCode))}`;
    if (inStock(e.to)) {
      line += " · " + esc(deliveryLabel(e.rawState));
      const cp = p && a.provider?.configPrice?.(p, e.config);
      if (cp) line += ` · <b>${cp.price.toFixed(2)} ${esc(p.currency)}/月</b>`;
      if (!linked && p && a.provider?.orderUrl) {
        const u = a.provider.orderUrl(p, e.config, e.location);
        if (u) [orderUrl, linked] = [u, true];
      }
      restock.push(line);
    } else {
      soldout.push(line);
    }
  }
  const name = p?.name || a.subscription.productCode;
  let b = restock.length ? "🟢 <b>补货</b> " : "🔴 <b>售罄</b> ";
  b += `<b>${esc(name)}</b> <code>${esc(a.subscription.productCode)}</code> · ${esc(a.regionLabel)}\n`;
  if (p) {
    const parts: string[] = [];
    if (p.specs.cpu) parts.push("CPU " + p.specs.cpu);
    if (p.specs.memory) parts.push("内存 " + labels.memory(p.specs.memory));
    if (p.specs.storage) parts.push("硬盘 " + labels.storage(p.specs.storage));
    if (p.price > 0) parts.push(`${p.price.toFixed(2)} ${p.currency}/月起`);
    if (p.setupFee > 0) parts.push(`安装费 ${p.setupFee.toFixed(2)} ${p.currency}`);
    if (parts.length) b += esc(parts.join(" · ")) + "\n";
  }
  const writeLines = (title: string, lines: string[]) => {
    if (!lines.length) return;
    b += `\n${title}\n`;
    for (const [i, l] of lines.entries()) {
      if (i === maxLines) {
        b += `… 另有 ${lines.length - maxLines} 项\n`;
        break;
      }
      b += l + "\n";
    }
  };
  writeLines("<b>有货：</b>", restock);
  writeLines("<b>已售罄：</b>", soldout);
  if (a.subscription.note) b += `\n📝 ${esc(a.subscription.note)}\n`;
  if (orderUrl && restock.length) b += `\n<a href="${esc(orderUrl)}">${linked ? "前往下单（已预选第一个有货配置）→" : "前往下单 →"}</a>`;
  return b;
}
