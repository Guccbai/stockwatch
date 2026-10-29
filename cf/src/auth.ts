// Password hashing and session tokens. bcrypt (the Go version) is too CPU-heavy in pure JS, so
// passwords use WebCrypto PBKDF2-SHA256 at the Workers maximum of 100k iterations.

export const cookieName = "sw_session";
export const sessionTTL = 30 * 24 * 3600_000;
export const minPassLen = 8;

const iterations = 100_000;
const enc = new TextEncoder();

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function randomToken(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pbkdf2(pw: string, salt: Uint8Array, iter: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
}

// "pbkdf2-sha256$<iterations>$<salt>$<hash>"
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(await pbkdf2(pw, salt, iterations))}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !hash) return false;
  const got = new Uint8Array(await pbkdf2(pw, fromB64url(salt), Number(iter)));
  const want = fromB64url(hash);
  return got.byteLength === want.byteLength && crypto.subtle.timingSafeEqual(got, want);
}

// Sessions are stored by hash so a database leak doesn't hand out live tokens.
export async function tokenHash(token: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(token)));
}

export function sameSecret(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}
