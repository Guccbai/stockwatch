// Email alerts through the Resend API. Port of internal/notify/resend.
import { formatAlert, type Alert } from "./telegram";
import { inStock } from "./types";

export interface ResendConfig {
  key: string;
  from: string;
  to: string[];
  apiBase: string;
}

export function resendConfig(key: string, from: string, to: string, apiBase?: string): ResendConfig | null {
  const addrs = to.split(",").map((a) => a.trim()).filter(Boolean);
  if (!key || !from.trim() || !addrs.length) return null;
  return { key, from: from.trim(), to: addrs, apiBase: (apiBase || "https://api.resend.com").replace(/\/+$/, "") };
}

// One-line summary, e.g. "🟢 补货 KS-6 (24sk602) · OVHcloud · 欧洲".
export function subject(a: Alert): string {
  const status = a.events.some((e) => inStock(e.to)) ? "🟢 补货" : "🔴 售罄";
  const code = a.subscription.productCode;
  const name = a.product?.name && a.product.name !== code ? `${a.product.name} (${code})` : code;
  return `${status} ${name} · ${a.regionLabel}`;
}

// Wraps the Telegram-flavoured HTML (b, code, a and newlines) into an email document.
export const htmlBody = (msg: string) =>
  `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#111">` +
  msg.replaceAll("\n", "<br>\n") + `</div>`;

const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#34;": '"', "&quot;": '"', "&#39;": "'" };

export const plainText = (msg: string) =>
  msg.replace(/<a href="([^"]*)">([^<]*)<\/a>/g, "$2 $1").replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#34|#39);/g, (m) => entities[m]);

export const notify = (cfg: ResendConfig, a: Alert) => {
  const body = formatAlert(a);
  return send(cfg, subject(a), htmlBody(body), plainText(body));
};

export const sendTest = (cfg: ResendConfig) => {
  const msg = "✅ <b>StockWatch</b> 测试邮件：Resend 邮件通知配置成功。";
  return send(cfg, "StockWatch 测试邮件", htmlBody(msg), plainText(msg));
};

async function send(cfg: ResendConfig, subject: string, html: string, text: string): Promise<void> {
  const body = JSON.stringify({ from: cfg.from, to: cfg.to, subject, html, text });
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(cfg.apiBase + "/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.ok) return;
    let msg = `${resp.status} ${resp.statusText}`;
    try {
      msg = ((await resp.json()) as { message?: string }).message || msg;
    } catch {}
    if (resp.status === 429 && attempt < 2) {
      await new Promise((ok) => setTimeout(ok, Math.max(Number(resp.headers.get("Retry-After")) || 0, 1) * 1000));
      continue;
    }
    throw new Error(`resend: ${msg}`);
  }
}
