import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./env.ts";
import { HttpError } from "./util.ts";

// ---------------------------------------------------------------------------
// Password hashing — PBKDF2 via the Web Crypto API (works natively in Workers,
// no bcrypt native dependency). Stored format:
//   pbkdf2$<iterations>$<saltBase64>$<hashBase64>
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Constant-time comparison of two byte arrays. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations)) return false;
  const salt = fromBase64(parts[2]);
  const expected = fromBase64(parts[3]);
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Session JWTs (HS256) stored in an HttpOnly cookie.
// ---------------------------------------------------------------------------

const COOKIE_NAME = "tm_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function secretKey(env: Env): Uint8Array {
  if (!env.JWT_SECRET) {
    throw new HttpError(500, "Server misconfigured: JWT_SECRET is not set");
  }
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function createSessionToken(
  userId: string,
  env: Env,
): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey(env));
}

export async function verifySessionToken(
  token: string,
  env: Env,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(env));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string): string {
  return [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

export function clearSessionCookie(): string {
  return [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ].join("; ");
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

/** Returns the authenticated user id or throws HttpError(401). */
export async function requireUser(req: Request, env: Env): Promise<string> {
  const token = readSessionCookie(req);
  if (!token) throw new HttpError(401, "Not authenticated");
  const userId = await verifySessionToken(token, env);
  if (!userId) throw new HttpError(401, "Not authenticated");
  return userId;
}
