interface Env {
  HUB: DurableObjectNamespace<import("./hub").Hub>;
  POLLER: DurableObjectNamespace<import("./poller").Poller>;
  VERSION?: string;
  // Initial admin password, used only until one is set in the WebUI (like SW_ADMIN_PASSWORD).
  ADMIN_PASSWORD?: string;
  // Optional overrides of the WebUI settings (like SW_TELEGRAM_TOKEN, …).
  TELEGRAM_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  RESEND_TO?: string;
  // Fixed Telegram webhook secret; by default the Hub generates and stores one.
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_API?: string;
  RESEND_API?: string;
  FAKE_PROVIDER?: string;
}
