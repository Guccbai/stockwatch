import { fake } from "./fake";
import { ovh } from "./ovh";
import type { Provider } from "./types";

export function providers(env: Env): Provider[] {
  return env.FAKE_PROVIDER === "true" ? [ovh, fake] : [ovh];
}

export function provider(env: Env, id: string): Provider | undefined {
  return providers(env).find((p) => p.id === id);
}

// "OVHcloud · 欧洲", falling back to the raw ids.
export function regionLabel(env: Env, providerId: string, region: string): string {
  const p = provider(env, providerId);
  const r = p?.regions.find((r) => r.id === region);
  return `${p?.name ?? providerId} · ${r?.name ?? region.toUpperCase()}`;
}
