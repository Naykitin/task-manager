import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./env.ts";
import {
  ALL_SCOPES,
  parseScopes,
  randomToken,
  sha256Hex,
  type Scope,
} from "./apikeys.ts";
import { readSessionCookie, sessionCookie, createSessionToken, verifySessionToken, verifyPassword } from "./auth.ts";
import { DUMMY_PASSWORD_HASH } from "./routes/auth.ts";
import { HttpError, newId } from "./util.ts";
import { allow, clientIp } from "./ratelimit.ts";

// ---------------------------------------------------------------------------
// OAuth 2.1 authorization server for remote MCP clients (Claude.ai, ChatGPT,
// ...): discovery metadata (RFC 8414 / RFC 9728), dynamic client registration
// (RFC 7591), authorization code + PKCE (S256 only), refresh-token rotation.
// Public clients only (token_endpoint_auth_method = none). The login/consent
// page is rendered by the Worker itself and reuses email+password accounts.
// ---------------------------------------------------------------------------

const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const MAX_CLIENTS = 500;
const REQUEST_AUD = "oauth-authorize";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function originOf(req: Request): string {
  return new URL(req.url).origin;
}

function oauthJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
    },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return oauthJson({ error, error_description: description }, status);
}

// ---- Discovery -------------------------------------------------------------

function protectedResourceMetadata(req: Request): Response {
  const origin = originOf(req);
  return oauthJson({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Task Manager MCP",
  });
}

function authServerMetadata(req: Request): Response {
  const origin = originOf(req);
  return oauthJson({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ALL_SCOPES,
    authorization_response_iss_parameter_supported: true,
  });
}

/** Value for the WWW-Authenticate header on 401s from /mcp. */
export function mcpChallenge(req: Request): string {
  return `Bearer realm="task-manager-mcp", resource_metadata="${originOf(req)}/.well-known/oauth-protected-resource"`;
}

// ---- Dynamic client registration -------------------------------------------

const BLOCKED_SCHEMES = new Set([
  "javascript:", "data:", "file:", "vbscript:", "blob:", "about:",
  "intent:", "content:", "ws:", "wss:", "ftp:", "ftps:",
]);

function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 500) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (BLOCKED_SCHEMES.has(u.protocol) || u.protocol.startsWith("ms-")) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  }
  // Custom scheme for native apps (must start with letter, alphanumeric, no uppercase)
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

/** Matches requested redirect URI against registered URIs, supporting RFC 8252 loopback ports. */
function matchRedirectUri(registeredUris: string[], requestedUri: string): boolean {
  if (registeredUris.includes(requestedUri)) return true;
  try {
    const req = new URL(requestedUri);
    // RFC 8252 Section 7.3: loopback IP literals allow arbitrary ephemeral ports
    if (req.protocol === "http:" && (req.hostname === "127.0.0.1" || req.hostname === "[::1]")) {
      return registeredUris.some((reg) => {
        try {
          const r = new URL(reg);
          return (
            r.protocol === "http:" &&
            r.hostname === req.hostname &&
            r.pathname === req.pathname
          );
        } catch {
          return false;
        }
      });
    }
  } catch {
    return false;
  }
  return false;
}

async function register(req: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(validRedirectUri)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be 1-5 valid https/loopback/custom-scheme URIs");
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    return oauthError("invalid_client_metadata", "Only token_endpoint_auth_method=none (public clients with PKCE) is supported");
  }
  const name =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, 100)
      : "MCP client";

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_clients").first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_CLIENTS) {
    // Evict oldest client without active tokens to prevent DoS
    const oldestInactive = await env.DB.prepare(
      `SELECT c.client_id FROM oauth_clients c
        WHERE NOT EXISTS (
          SELECT 1 FROM oauth_tokens t
           WHERE t.client_id = c.client_id AND t.revoked_at IS NULL AND t.refresh_expires_at > ?
        )
        ORDER BY c.created_at ASC LIMIT 1`,
    )
      .bind(new Date().toISOString())
      .first<{ client_id: string }>();

    const targetId = oldestInactive?.client_id;
    if (targetId) {
      await env.DB.prepare("DELETE FROM oauth_clients WHERE client_id = ?").bind(targetId).run();
    } else {
      // If all have active tokens, evict the oldest created client
      await env.DB.prepare(
        "DELETE FROM oauth_clients WHERE client_id IN (SELECT client_id FROM oauth_clients ORDER BY created_at ASC LIMIT 1)",
      ).run();
    }
  }

  const clientId = newId();
  await env.DB.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)")
    .bind(clientId, name, JSON.stringify(uris))
    .run();
  return oauthJson(
    {
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201,
  );
}

// ---- Authorization endpoint (login + consent page) -------------------------

interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

async function loadClient(env: Env, clientId: string | null | undefined): Promise<Client | null> {
  if (!clientId) return null;
  const row = await env.DB.prepare(
    "SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?",
  )
    .bind(clientId)
    .first<{ client_id: string; client_name: string; redirect_uris: string }>();
  if (!row) return null;
  return { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] };
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function html(status: number, title: string, body: string, extra: Record<string, string> = {}): Response {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:8vh auto;padding:0 1.25rem}
h1{font-size:1.3rem}.box{border:1px solid #8884;border-radius:10px;padding:1rem 1.1rem;margin:1rem 0}
label{display:block;margin:.6rem 0 .2rem}input[type=email],input[type=password]{width:100%;padding:.55rem;box-sizing:border-box}
.scope{display:flex;gap:.5rem;align-items:flex-start;margin:.5rem 0}.muted{opacity:.7;font-size:.9rem}
.err{color:#c0392b}.row{display:flex;gap:.6rem;margin-top:1rem}button{padding:.6rem 1.1rem;font-size:1rem;cursor:pointer}
button.primary{font-weight:600}code{word-break:break-all}
</style></head><body>${body}</body></html>`;
  return new Response(page, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      ...extra,
    },
  });
}

function errorPage(message: string): Response {
  return html(400, "Authorization error", `<h1>Authorization error</h1><p class="err">${esc(message)}</p>`);
}

function redirectTo(redirectUri: string, params: Record<string, string | undefined>, issuer: string, extra: Record<string, string> = {}): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  u.searchParams.set("iss", issuer);
  return new Response(null, { status: 303, headers: { location: u.toString(), "cache-control": "no-store", ...extra } });
}

interface AuthzRequest {
  cid: string;
  ru: string;
  cc: string;
  sc: string;
  st?: string;
  uid?: string;
}

function jwtKey(env: Env): Uint8Array {
  if (!env.JWT_SECRET) throw new HttpError(500, "Server misconfigured: JWT_SECRET is not set");
  return new TextEncoder().encode(env.JWT_SECRET);
}

async function signRequest(env: Env, r: AuthzRequest): Promise<string> {
  return new SignJWT({ ...r })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(REQUEST_AUD)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(jwtKey(env));
}

async function verifyRequest(env: Env, token: string): Promise<AuthzRequest | null> {
  try {
    const { payload } = await jwtVerify(token, jwtKey(env), { audience: REQUEST_AUD });
    return payload as unknown as AuthzRequest;
  } catch {
    return null;
  }
}

async function sessionUser(req: Request, env: Env): Promise<{ id: string; email: string } | null> {
  const token = readSessionCookie(req);
  if (!token) return null;
  const id = await verifySessionToken(token, env);
  if (!id) return null;
  return env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(id).first<{ id: string; email: string }>();
}

const SCOPE_HELP: Record<Scope, string> = {
  read: "Read your boards, tasks and time tracking",
  write: "Create and edit boards and tasks, move tasks, run timers",
  delete: "Permanently delete tasks, columns and boards",
};

function consentPage(opts: {
  client: Client;
  redirectUri: string;
  requestToken: string;
  requested: Scope[];
  user: { email: string } | null;
  error?: string;
}): Response {
  const { client, redirectUri, requestToken, requested, user, error } = opts;
  let host = redirectUri;
  try {
    host = new URL(redirectUri).host || redirectUri;
  } catch {
    /* keep raw */
  }
  const scopes = requested
    .map(
      (s) => `<label class="scope"><input type="checkbox" name="scope" value="${s}"${s === "delete" ? "" : " checked"}>
<span><strong>${s}</strong><br><span class="muted">${esc(SCOPE_HELP[s])}${s === "delete" ? " (off by default)" : ""}</span></span></label>`,
    )
    .join("");
  const login = user
    ? `<p class="muted">Signed in as <strong>${esc(user.email)}</strong></p>`
    : `<label for="email">Email</label><input id="email" type="email" name="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required>`;
  return html(
    200,
    "Authorize access",
    `<h1>Authorize <em>${esc(client.client_name)}</em></h1>
<p><strong>${esc(client.client_name)}</strong> wants to access your Task Manager.</p>
<p class="muted">After you decide, you'll be sent to <code>${esc(host)}</code>. Only continue if you started this connection.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="req" value="${esc(requestToken)}">
<div class="box">${login}</div>
<div class="box"><strong>Permissions</strong>${scopes}</div>
<div class="row"><button class="primary" type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button></div></form>`,
  );
}

function requestedScopes(raw: string | null): Scope[] {
  const parsed = raw ? [...parseScopes(raw)] : [];
  return parsed.length ? parsed : ["read", "write"];
}

async function authorizeGet(req: Request, env: Env): Promise<Response> {
  const p = new URL(req.url).searchParams;
  const client = await loadClient(env, p.get("client_id"));
  if (!client) return errorPage("Unknown client_id. The client must register first.");

  let redirectUri = p.get("redirect_uri");
  if (!redirectUri) {
    if (client.redirect_uris.length !== 1) return errorPage("redirect_uri is required.");
    redirectUri = client.redirect_uris[0];
  }
  if (!matchRedirectUri(client.redirect_uris, redirectUri)) {
    return errorPage("redirect_uri does not match a registered URI.");
  }

  const issuer = originOf(req);
  const state = p.get("state") ?? undefined;
  const fail = (error: string, desc: string) =>
    redirectTo(redirectUri!, { error, error_description: desc, state }, issuer);

  if (p.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
  const challenge = p.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || p.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }

  const user = await sessionUser(req, env);
  const requested = requestedScopes(p.get("scope"));
  const requestToken = await signRequest(env, {
    cid: client.client_id,
    ru: redirectUri,
    cc: challenge,
    sc: requested.join(" "),
    st: state,
    uid: user?.id,
  });
  return consentPage({ client, redirectUri, requestToken, requested, user });
}

async function authorizePost(req: Request, env: Env): Promise<Response> {
  // CSRF defence in depth (session cookie is also SameSite=Lax).
  const origin = req.headers.get("Origin");
  if (origin !== originOf(req)) {
    await req.arrayBuffer().catch(() => undefined); // drain the unread body
    return errorPage("Cross-origin submission blocked.");
  }

  const form = await req.formData();
  const authz = await verifyRequest(env, String(form.get("req") ?? ""));
  if (!authz) return errorPage("This authorization request expired. Please start again from your app.");

  const client = await loadClient(env, authz.cid);
  if (!client || !matchRedirectUri(client.redirect_uris, authz.ru)) return errorPage("Client is no longer valid.");

  const issuer = originOf(req);
  if (form.get("decision") !== "approve") {
    return redirectTo(authz.ru, { error: "access_denied", state: authz.st }, issuer);
  }

  const requested = requestedScopes(authz.sc);
  const rerender = async (error: string) =>
    consentPage({ client, redirectUri: authz.ru, requestToken: String(form.get("req")), requested, user: await sessionUser(req, env), error });

  // Identify the user: existing session, or verify submitted credentials.
  let userId: string | null = null;
  let cookie: Record<string, string> = {};
  const existing = await sessionUser(req, env);
  if (existing) {
    if (authz.uid && authz.uid !== existing.id) {
      return rerender("Account mismatch with initial request. Please re-authorize.");
    }
    userId = existing.id;
  } else {
    const email = String(form.get("email") ?? "").trim().toLowerCase().slice(0, 254);
    const password = String(form.get("password") ?? "").slice(0, 200);
    const row = email
      ? await env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ?")
          .bind(email)
          .first<{ id: string; password_hash: string }>()
      : null;
    const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_PASSWORD_HASH);
    if (!row || !ok) return rerender("Invalid email or password.");
    userId = row.id;
    cookie = { "set-cookie": sessionCookie(await createSessionToken(row.id, env)) };
  }

  const granted = form.getAll("scope").map(String).filter((s): s is Scope => requested.includes(s as Scope));
  if (granted.length === 0) return rerender("Select at least one permission, or press Deny.");

  const code = randomToken("tmc_");
  await env.DB.prepare(
    "INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      await sha256Hex(code),
      client.client_id,
      userId,
      authz.ru,
      authz.cc,
      granted.join(" "),
      new Date(Date.now() + CODE_TTL_MS).toISOString(),
    )
    .run();
  return redirectTo(authz.ru, { code, state: authz.st }, issuer, cookie);
}

// ---- Token endpoint --------------------------------------------------------

async function issueTokens(env: Env, userId: string, clientId: string, scopes: string): Promise<Response> {
  const access = randomToken("tmo_");
  const refresh = randomToken("tmr_");
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (id, access_hash, refresh_hash, client_id, user_id, scopes, access_expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId(),
      await sha256Hex(access),
      await sha256Hex(refresh),
      clientId,
      userId,
      scopes,
      new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString(),
      new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
    )
    .run();
  return oauthJson({
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: scopes,
  });
}

function base64Url(buf: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function token(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const ct = req.headers.get("content-type") ?? "";
  let params: URLSearchParams;
  if (ct.includes("application/json")) {
    try {
      const o = (await req.json()) as Record<string, unknown>;
      params = new URLSearchParams(Object.entries(o).map(([k, v]): [string, string] => [k, String(v)]));
    } catch {
      return oauthError("invalid_request", "Malformed JSON");
    }
  } else {
    params = new URLSearchParams(await req.text());
  }
  const now = new Date().toISOString();

  // Non-blocking cleanup of expired codes and tokens
  const cleanup = env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM oauth_tokens WHERE refresh_expires_at < ?").bind(now),
  ]).catch(() => undefined);
  if (ctx) ctx.waitUntil(cleanup);

  const grant = params.get("grant_type");

  if (grant === "authorization_code") {
    const code = params.get("code") ?? "";
    const verifier = params.get("code_verifier") ?? "";
    if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      return oauthError("invalid_request", "code and a valid code_verifier are required");
    }
    // Single use: atomically consume the code.
    const row = await env.DB.prepare(
      `DELETE FROM oauth_codes WHERE code_hash = ?
       RETURNING client_id, user_id, redirect_uri, code_challenge, scopes, expires_at`,
    )
      .bind(await sha256Hex(code))
      .first<{ client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scopes: string; expires_at: string }>();
    if (!row || row.expires_at < now) return oauthError("invalid_grant", "Invalid or expired code");
    const clientId = params.get("client_id");
    if (clientId !== row.client_id) return oauthError("invalid_grant", "client_id mismatch");
    const redirectUri = params.get("redirect_uri");
    if (!redirectUri || !matchRedirectUri([row.redirect_uri], redirectUri)) {
      return oauthError("invalid_grant", "redirect_uri is required and must match");
    }
    const challenge = base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    if (challenge !== row.code_challenge) return oauthError("invalid_grant", "PKCE verification failed");
    return issueTokens(env, row.user_id, row.client_id, row.scopes);
  }

  if (grant === "refresh_token") {
    const refresh = params.get("refresh_token") ?? "";
    if (!refresh.startsWith("tmr_")) return oauthError("invalid_grant", "Invalid refresh token");
    const row = await env.DB.prepare(
      `SELECT id, client_id, user_id, scopes, refresh_expires_at, revoked_at
         FROM oauth_tokens WHERE refresh_hash = ?`,
    )
      .bind(await sha256Hex(refresh))
      .first<{ id: string; client_id: string; user_id: string; scopes: string; refresh_expires_at: string; revoked_at: string | null }>();
    if (!row) return oauthError("invalid_grant", "Invalid refresh token");
    if (row.revoked_at) {
      // Reuse of a rotated token: assume theft, kill the whole grant.
      await env.DB.prepare(
        "UPDATE oauth_tokens SET revoked_at = ? WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL",
      )
        .bind(now, row.client_id, row.user_id)
        .run();
      return oauthError("invalid_grant", "Refresh token was already used");
    }
    if (row.refresh_expires_at < now) return oauthError("invalid_grant", "Refresh token expired");
    const clientId = params.get("client_id");
    if (!clientId || clientId !== row.client_id) {
      return oauthError("invalid_grant", "client_id is required and must match");
    }
    const res = await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now, row.id)
      .run();
    if (!res.meta.changes) return oauthError("invalid_grant", "Refresh token was already used");
    return issueTokens(env, row.user_id, row.client_id, row.scopes);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

// ---- Router ----------------------------------------------------------------

/** Handles /.well-known/oauth-* and /oauth/*; other paths fall through to assets. */
export async function handleOAuth(
  req: Request,
  env: Env,
  url: URL,
  ctx?: ExecutionContext,
): Promise<Response> {
  const path = url.pathname;
  const isOurs =
    path.startsWith("/oauth/") ||
    path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-protected-resource/mcp" ||
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/oauth-authorization-server/mcp";
  if (!isOurs) return env.ASSETS.fetch(req);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "POST") {
    const limiter = (path === "/oauth/authorize" || path === "/oauth/register") ? env.AUTH_LIMITER : env.MCP_LIMITER;
    if (!(await allow(limiter, `oauth:${path}:${clientIp(req)}`))) {
      await req.arrayBuffer().catch(() => undefined);
      return new Response(JSON.stringify({ error: "rate_limited", error_description: "Too many requests, slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60", ...CORS },
      });
    }
  }

  try {
    if (req.method === "GET") {
      if (path.startsWith("/.well-known/oauth-protected-resource")) return protectedResourceMetadata(req);
      if (path.startsWith("/.well-known/oauth-authorization-server")) return authServerMetadata(req);
      if (path === "/oauth/authorize") return await authorizeGet(req, env);
    }
    if (req.method === "POST") {
      if (path === "/oauth/register") return await register(req, env);
      if (path === "/oauth/token") return await token(req, env, ctx);
      if (path === "/oauth/authorize") return await authorizePost(req, env);
    }
  } catch (e) {
    if (e instanceof HttpError) return oauthError("server_error", e.message, e.status);
    console.error("OAuth error:", e);
    return oauthError("server_error", "Internal server error", 500);
  }
  return oauthError("invalid_request", "Not found", 404);
}
