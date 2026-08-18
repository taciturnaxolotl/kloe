import { createHash, randomBytes } from "node:crypto";
import { getConfig, type RolePolicy } from "./settings";
import type { Session, SessionProfile, Store } from "./store";

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
// A pre-registered client_id wins; otherwise kloe's own Client ID Metadata
// Document URL (the public/dynamic default).
const clientId = (): string =>
  getConfig().auth.clientId || trimSlash(getConfig().auth.baseUrl) + "/client-metadata.json";
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
    if (path === "/health") {
      out[path] = methods;
      continue;
    }
    const wrapped: Record<string, Handler> = {};
    for (const [method, fn] of Object.entries(methods)) {
      wrapped[method] = (req, ...rest) => {
        if (!getSession(req, store))
          return Response.json({ error: "unauthorized" }, { status: 401 });
        return fn(req, ...rest);
      };
    }
    out[path] = wrapped;
  }
  return out as T;
}

// ---- route handlers -----------------------------------------------------

const esc = (s: string): string =>
  s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);

/**
 * A standalone, theme-aware auth page (login lives on the IdP, so this is the
 * only kloe-served auth screen). Palette mirrors app.css so it looks like the app
 * in both light and dark. Self-contained — it's served before the SPA loads.
 */
function authPage(opts: {
  title: string;
  message: string;
  actionHref?: string;
  actionLabel?: string;
  status?: number;
  clearCookie?: boolean;
}): Response {
  const brand = esc(getConfig().auth.appName || "kloe");
  const action = opts.actionHref
    ? `<a class="btn" href="${esc(opts.actionHref)}">${esc(opts.actionLabel ?? "Continue")}</a>`
    : "";
  const body = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#5577a3">
<title>${esc(opts.title)} · ${brand}</title>
<style>
  /* Standalone (served before the SPA bundle), but the tokens mirror app.css so
     it reads as the same product in both light and dark. */
  :root{
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    --bg:#ffffff;--bg-raise:#ffffff;--ink:#17181a;--muted:#6a6d73;
    --rule:#e6e7e9;--rule-strong:#d9dade;--accent:#5577a3}
  @media (prefers-color-scheme:dark){:root{
    --bg:#121315;--bg-raise:#1a1b1e;--ink:#e8e9ea;--muted:#9a9da3;
    --rule:#2a2c2f;--rule-strong:#3a3d42;--accent:#5577a3}}
  *{box-sizing:border-box}html,body{height:100%}
  body{margin:0;display:grid;place-items:center;padding:1.5rem;background:var(--bg);color:var(--ink);
    font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:22rem;background:var(--bg-raise);border:1px solid var(--rule);
    border-radius:12px;padding:1.9rem 1.75rem;text-align:center}
  .brand{display:inline-flex;align-items:center;gap:.5rem;font-weight:700;font-size:15px;
    letter-spacing:-.02em;color:var(--ink)}
  .brand img{width:26px;height:26px;border-radius:7px;display:block}
  h1{font-size:1rem;font-weight:600;margin:1.35rem 0 .3rem}
  p{color:var(--muted);font-size:.9rem;margin:0 auto;max-width:28ch}
  .btn{display:inline-block;margin-top:1.5rem;padding:8px 16px;font-size:13.5px;font-weight:500;
    background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:8px;text-decoration:none}
  .btn:hover{filter:brightness(1.08)}
  .btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style></head>
<body><main class="card">
  <div class="brand"><img src="/icon-192.png" alt="" width="26" height="26">${brand}</div>
  <h1>${esc(opts.title)}</h1>
  <p>${esc(opts.message)}</p>
  ${action}
</main></body></html>`;
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  if (opts.clearCookie) headers.append("Set-Cookie", serializeCookie(OAUTH_COOKIE, "", 0));
  return new Response(body, { status: opts.status ?? 200, headers });
}

function htmlError(message: string, status = 400): Response {
  return authPage({
    title: "Sign-in failed",
    message,
    actionHref: "/auth/login",
    actionLabel: "Try again",
    status,
    clearCookie: true,
  });
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
  headers.append(
    "Set-Cookie",
    serializeCookie(OAUTH_COOKIE, JSON.stringify({ state, verifier, returnTo }), 600),
  );
  return new Response(null, { status: 302, headers });
}

interface TokenResponse {
  me?: string;
  sub?: string;
  iss?: string;
  /** indiko's per-app RBAC: an arbitrary string an admin assigned for THIS app. */
  role?: string;
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
  try {
    saved = JSON.parse(parseCookies(req)[OAUTH_COOKIE] ?? "{}");
  } catch {
    /* malformed cookie */
  }

  if (!code || !state || !saved.state || state !== saved.state)
    return htmlError("Invalid or missing state.");
  if (iss && trimSlash(iss) !== trimSlash(cfg.issuer))
    return htmlError("The response came from an unexpected issuer.");

  const d = await discover();
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId(),
    redirect_uri: redirectUri(),
    code_verifier: saved.verifier ?? "",
  });
  if (cfg.clientSecret) tokenBody.set("client_secret", cfg.clientSecret); // confidential pre-registered client
  const tokenRes = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
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
  // Durable, not session-scoped: a job queued now may run after this session is
  // gone, and it still has to know what this person may reach.
  store.setUserRole(sub, tok.role);

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
  const base = trimSlash(cfg.baseUrl);
  return Response.json({
    client_id: clientId(),
    client_name: cfg.appName,
    client_uri: base,
    // A logo so the AS consent page shows kloe's branding (DCR/CIMD). Defaults to
    // kloe's own square icon; override with auth.logoUri.
    logo_uri: cfg.logoUri || base + "/icon-512.png",
    // /auth/callback for kloe's own login; /lard/callback for linking a user's
    // lard account (same client, shared authorization server).
    redirect_uris: [redirectUri(), base + "/lard/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
}

/**
 * What a signed-in user is allowed to be.
 *
 * `owner` runs the instance: curation, the admin views, every visible model.
 * `guest` gets a chat and nothing that decides what anyone else sees.
 *
 * Two cases deliberately resolve to owner: auth turned off (a local instance
 * has no one to be a guest to), and an empty `auth.owners` (a deployment that
 * never named owners hasn't opted into having guests — every instance behaved
 * this way before roles existed, and an upgrade must not silently demote its
 * only user).
 */
/**
 * A role is whatever string the identity provider assigned for this app; kloe
 * gives meaning to it through `auth.roles`. Two names are built in so a
 * deployment that configures nothing still works: `owner` runs the place and
 * `guest` may chat.
 */
export type Role = string;

export const OWNER: Role = "owner";
export const GUEST: Role = "guest";

/** What a role may do beyond chatting. Unknown roles get the guest's answer. */
export type Capability = "admin" | "sandbox" | "publish";

const BUILT_IN: Record<string, RolePolicy> = {
  owner: {
    admin: true,
    sandbox: true,
    publish: true,
    models: ["*"],
    subs: [],
    providerRoles: [],
  },
  guest: {
    admin: false,
    sandbox: false,
    publish: false,
    models: [],
    subs: [],
    providerRoles: [],
  },
};

/**
 * Whether this deployment has declared any roles. Until it does there are no
 * guests to be, and everyone who can sign in is an owner: that is what a
 * single-user instance is, and what every instance was before roles.
 */
function rolesInPlay(cfg: ReturnType<typeof getConfig>["auth"]): boolean {
  return Object.keys(cfg.roles).length > 0;
}

/**
 * The role this person holds.
 *
 * Named subjects win over the provider's answer. That order is the whole
 * break-glass: a role you assigned in config holds when the provider is
 * misconfigured, when it never assigned one, and when you are the person
 * fixing it — and it applies the moment the config is written, where the
 * provider's answer only arrives with a fresh sign-in.
 *
 * Anyone matching neither is a guest.
 */
export function roleFor(sub: string | undefined, providerRole?: string): Role {
  const cfg = getConfig().auth;
  if (!cfg.enabled || !rolesInPlay(cfg)) return OWNER;
  const roles = Object.entries(cfg.roles);
  if (sub) {
    const named = roles.find(([, policy]) => policy.subs.includes(sub));
    if (named) return named[0];
  }
  if (providerRole) {
    const mapped = roles.find(
      ([name, policy]) => policy.providerRoles.includes(providerRole) || name === providerRole,
    );
    if (mapped) return mapped[0];
  }
  return GUEST;
}

/** The policy for a role: what the config says, else the built-in of that name. */
export function policyFor(role: Role): RolePolicy {
  const cfg = getConfig().auth;
  if (!cfg.enabled || !rolesInPlay(cfg)) return BUILT_IN.owner!;
  return cfg.roles[role] ?? BUILT_IN[role] ?? BUILT_IN.guest!;
}

export function roleCan(role: Role, capability: Capability): boolean {
  return policyFor(role)[capability] === true;
}

/**
 * May this role pick this model from the ones the INSTANCE pays for?
 *
 * Patterns are `provider/model`, with `*` standing for a whole segment:
 * `"*"` is everything, `"hyper/*"` is one provider's, and anything else is an
 * exact ref. Deliberately not a general glob — a half-understood wildcard in a
 * spending rule is worse than no wildcard.
 */
export function roleMayUse(role: Role, ref: string): boolean {
  return policyFor(role).models.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern === ref) return true;
    return pattern.endsWith("/*") && ref.startsWith(pattern.slice(0, -1));
  });
}

/** Roles this deployment knows about, for the UI that hands things out. */
export function declaredRoles(): Role[] {
  const cfg = getConfig().auth;
  return [...new Set<string>([OWNER, GUEST, ...Object.keys(cfg.roles)])];
}

/** The role of whoever made this request. */
export function requestRole(req: Request, store: Store): Role {
  const sub = getSession(req, store)?.sub;
  return roleFor(sub, sub ? store.getUserRole(sub) : undefined);
}

/** Whether this request may do `capability`. */
export function can(req: Request, store: Store, capability: Capability): boolean {
  return roleCan(requestRole(req, store), capability);
}

/** The public shape of the signed-in user, for `/api/me`. */
export function sessionUser(
  session: Session,
  providerRole?: string,
): {
  sub: string;
  role: Role;
  name?: string;
  picture?: string;
  url?: string;
  email?: string;
} {
  // `role` here is kloe's own answer (owner | guest), not the provider's raw
  // string — the profile spread comes first so it can never shadow it.
  return { ...session.profile, sub: session.sub, role: roleFor(session.sub, providerRole) };
}
