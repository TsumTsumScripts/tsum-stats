// Hashes and keys. Contributor keys are kept as SHA-256; device tags and
// addresses only ever as an HMAC under DEVICE_KEY (CONTRACT §1.1, §2.1).

const enc = new TextEncoder();
const bytes = (v: string | Uint8Array) => (typeof v === "string" ? enc.encode(v) : v);

export const toHex = (buf: ArrayBuffer | Uint8Array) =>
  Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const sha256Hex = async (v: string | Uint8Array) => toHex(await crypto.subtle.digest("SHA-256", bytes(v)));

export const hmacKey = (secret: string) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

export const hmacHex = async (key: CryptoKey, v: string | Uint8Array) => toHex(await crypto.subtle.sign("HMAC", key, bytes(v)));

/** A new contributor key: 32 random bytes as base64url, 43 characters. */
export function newKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** a === b in constant time; an empty secret never matches. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}
