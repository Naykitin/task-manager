import type { Env } from "../env.ts";
import { HttpError } from "../util.ts";

// Encrypts small secrets (user-supplied API keys) before they reach D1.
// AES-256-GCM; the key is derived from the SETTINGS_ENCRYPTION_KEY Worker
// secret, and the user id is bound as additional authenticated data so a
// ciphertext copied to another user's row will not decrypt.
// Stored format: v1.<iv base64>.<ciphertext base64>

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encryptionAvailable(env: Env): boolean {
  return typeof env.SETTINGS_ENCRYPTION_KEY === "string" && env.SETTINGS_ENCRYPTION_KEY.length >= 16;
}

async function importKey(env: Env): Promise<CryptoKey> {
  if (!encryptionAvailable(env)) {
    throw new HttpError(
      503,
      "Saving API keys is not enabled on this server: set the SETTINGS_ENCRYPTION_KEY secret first.",
    );
  }
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(env.SETTINGS_ENCRYPTION_KEY!));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env: Env, aad: string, plain: string): Promise<string> {
  const key = await importKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plain),
  );
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

/** Returns null if the value is malformed, was encrypted for someone else, or the secret changed. */
export async function decryptSecret(env: Env, aad: string, stored: string): Promise<string | null> {
  try {
    const [v, ivB64, ctB64] = stored.split(".");
    if (v !== "v1" || !ivB64 || !ctB64) return null;
    const key = await importKey(env);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(ivB64), additionalData: enc.encode(aad) },
      key,
      unb64(ctB64),
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}
