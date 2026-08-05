import { randomBytes, createHash } from "node:crypto";
import { getConfig } from "./settings";
import type { Store, Session, SessionProfile } from "./store";

/**
 * Auth against an indiko-style OAuth 2.0 / OIDC server, as a public client:
 * Authorization Code + PKCE, no client secret. The `client_id` is kloe's own
 * /client-metadata.json document and the redirect is /auth/callback. On success
 * we don't keep the provider's tokens — we mint our own opaque cookie session
 * (see store.sessions) and gate `/api/*` on it; the SPA redirects to /auth/login
 * on a 401. Cookie sessions (not bearer headers) so native EventSource works.
 *
 * Everything is a no-op unless `auth.enabled` — local dev and single-user setups
 * run open, exactly as before.
 */

const SESSION_COOKIE = "kloe_session";
const OAUTH_COOKIE = "kloe_oauth"; // short-lived: carries PKCE verifier + state across the redirect

export function authEnabled(): boolean {
  return getConfig().auth.enabled;
}

// ---- small crypto / url helpers ----------------------------------------

const b64url = (b: Buffer): string => b.toString("base64url");
const token = (bytes = 32): string => b64url(randomBytes(bytes));
function pkce(): { verifier: string; challenge: string } {
  const verifier = token(32);
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
const trimSlash = (s: string): string => s.replace(/\/+$/, "");
const isSecure = (): boolean => getConfig().auth.baseUrl.startsWith("https");
const clientId = (): string => trimSlash(getConfig().auth.baseUrl) + "/client-metadata.json";
const redirectUri = (): string => trimSlash(getConfig().auth.baseUrl) + "/auth/callback";
/** Only same-origin relative paths — never an open redirect off-site. */
function safeReturn(rt: unknown): string {
  return typeof rt === "string" && rt.startsWith("/") && !rt.startsWith("//") ? rt : "/";
}

// ---- cookies ------------------------------------------------------------

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie");
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function serializeCookie(name: string, value: string, maxAgeSec: number): string {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
  if (isSecure()) s += "; Secure";
  return s;
}

// ---- OIDC discovery (cached) --------------------------------------------

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  issuer?: string;
}
let discoveryCache: Promise<Discovery> | null = null;
function discover(): Promise<Discovery> {
  if (!discoveryCache) {
    discoveryCache = (async () => {
      const url = trimSlash(getConfig().auth.issuer) + "/.well-known/openid-configuration";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      return (await res.json()) as Discovery;
    })();
  }
  return discoveryCache;
}
/** Drops the cached discovery doc (tests / config reload). */
export function resetAuthCache(): void {
  discoveryCache = null;
}

// ---- session lookup + the API gate --------------------------------------

/** The live session for a request, or undefined (missing/expired cookie). */
export function getSession(req: Request, store: Store): Session | undefined {
  const id = parseCookies(req)[SESSION_COOKIE];
  return id ? store.getSession(id) : undefined;
}

type Handler = (req: Request, ...rest: unknown[]) => Response | Promise<Response>;
type Routes = Record<string, Record<string, Handler>>;

/**
 * Wraps API route handlers so each requires a valid session (401 otherwise).
 * A no-op when auth is disabled. `/health` stays open for probes.
 */
export function gateApi<T extends Routes>(routes: T, store: Store): T {
  if (!authEnabled()) return routes;
  const out: Routes = {};
  for (const [path, methods] of Object.entries(routes)) {
    if (path === "/health") { out[path] = methods; continue; }
    const wrapped: Record<string, Handler> = {};
    for (const [method, fn] of Object.entries(methods)) {
      wrapped[method] = (req, ...rest) => {
        if (!getSession(req, store)) return Response.json({ error: "unauthorized" }, { status: 401 });
        return fn(req, ...rest);
      };
    }
    out[path] = wrapped;
  }
  return out as T;
}

// ---- route handlers -----------------------------------------------------

function htmlError(message: string, status = 400): Response {
  const clear = serializeCookie(OAUTH_COOKIE, "", 0);
  const safe = message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  const body = `<!doctype html><meta charset="utf-8"><title>Sign in</title>` +
    `<body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5">` +
    `<h1 style="font-size:1.1rem">Sign-in failed</h1><p>${safe}</p><p><a href="/auth/login">Try again</a></p>`;
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": clear } });
}

/** /auth/login — start the flow: PKCE + state in a cookie, redirect to the IdP. */
export async function handleLogin(req: Request): Promise<Response> {
  const { verifier, challenge } = pkce();
  const state = token(16);
  const returnTo = safeReturn(new URL(req.url).searchParams.get("returnTo"));
  const d = await discover();
  const authorize = new URL(d.authorization_endpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId());
  authorize.searchParams.set("redirect_uri", redirectUri());
  authorize.searchParams.set("scope", "profile email");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  const headers = new Headers({ Location: authorize.href });
  headers.append("Set-Cookie", serializeCookie(OAUTH_COOKIE, JSON.stringify({ state, verifier, returnTo }), 600));
  return new Response(null, { status: 302, headers });
}

interface TokenResponse {
  me?: string;
  sub?: string;
  iss?: string;
  profile?: { name?: string; email?: string; photo?: string; picture?: string; url?: string };
}

/** /auth/callback — verify state/iss, exchange the code, mint a session. */
export async function handleCallback(req: Request, store: Store): Promise<Response> {
  const cfg = getConfig().auth;
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const iss = url.searchParams.get("iss");
  let saved: { state?: string; verifier?: string; returnTo?: string } = {};
  try { saved = JSON.parse(parseCookies(req)[OAUTH_COOKIE] ?? "{}"); } catch { /* malformed cookie */ }

  if (!code || !state || !saved.state || state !== saved.state) return htmlError("Invalid or missing state — please retry.");
  if (iss && trimSlash(iss) !== trimSlash(cfg.issuer)) return htmlError("The response came from an unexpected issuer.");

  const d = await discover();
  const tokenRes = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId(),
      redirect_uri: redirectUri(),
      code_verifier: saved.verifier ?? "",
    }),
  });
  if (!tokenRes.ok) return htmlError(`Token exchange failed (${tokenRes.status}).`);
  const tok = (await tokenRes.json()) as TokenResponse;
  const sub = tok.me ?? tok.sub;
  if (!sub) return htmlError("The provider returned no subject.");
  if (cfg.allowedSubs.length > 0 && !cfg.allowedSubs.includes(sub)) {
    return htmlError("Your account is not authorized for this instance.", 403);
  }

  const profile: SessionProfile = {
    name: tok.profile?.name,
    email: tok.profile?.email,
    picture: tok.profile?.photo ?? tok.profile?.picture,
    url: tok.profile?.url,
  };
  const sid = token(32);
  const ttlSec = cfg.sessionTtlDays * 86400;
  store.createSession(sid, sub, profile, Date.now() + ttlSec * 1000);

  const headers = new Headers({ Location: safeReturn(saved.returnTo) });
  headers.append("Set-Cookie", serializeCookie(OAUTH_COOKIE, "", 0)); // clear the transient cookie
  headers.append("Set-Cookie", serializeCookie(SESSION_COOKIE, sid, ttlSec));
  return new Response(null, { status: 302, headers });
}

/** /auth/logout — drop the session and its cookie, back to the login flow. */
export function handleLogout(req: Request, store: Store): Response {
  const id = parseCookies(req)[SESSION_COOKIE];
  if (id) store.deleteSession(id);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", serializeCookie(SESSION_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

/** /client-metadata.json — the public Client ID Metadata Document indiko fetches. */
export function clientMetadata(): Response {
  const cfg = getConfig().auth;
  return Response.json({
    client_id: clientId(),
    client_name: cfg.appName,
    ...(cfg.logoUri ? { logo_uri: cfg.logoUri } : {}),
    redirect_uris: [redirectUri()],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
}

/** The public shape of the signed-in user, for `/api/me`. */
export function sessionUser(session: Session): { sub: string; name?: string; picture?: string; url?: string; email?: string } {
  return { sub: session.sub, ...session.profile };
}
