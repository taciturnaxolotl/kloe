/*
 * Client for a lard memory server (../lard) — kloe's optional memory layer.
 *
 * Auth is the OAuth 2.1 device authorization grant (RFC 8628), PER kloe user:
 * each user's token is stored in the DB keyed by their `sub` (store.ts
 * lard_tokens) and refreshed lazily. Everything is gated by the deployment-level
 * `lard` config (which lard, which OAuth client); when it's absent/disabled or a
 * user isn't connected, callers simply don't reach here.
 *
 * Discovery follows RFC 9728 → RFC 8414: ask lard which authorization server
 * protects it, then ask that server where its device + token endpoints are.
 * Nothing about the provider is hardcoded (mirrors lard's own client).
 */
import { randomBytes, createHash } from "node:crypto";
import { getConfig } from "./settings";
import { getSession, authEnabled, parseCookies } from "./auth";
import type { Store, LardToken } from "./store";

/** The implicit user when kloe auth is disabled (single-user/local). */
export const LOCAL_SUB = "local";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const trimSlash = (s: string): string => s.replace(/\/+$/, "");
const cfg = () => getConfig().lard;
export function lardEnabled(): boolean { return cfg().enabled && !!cfg().baseUrl; }
export function lardConnected(store: Store, sub: string): boolean { return !!store.getLardToken(sub); }

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(cfg().timeoutMs) });
  if (!res.ok) throw new Error(`lard: ${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ---- discovery (cached) --------------------------------------------------
interface Endpoints { authorization?: string; token: string; deviceAuthorization: string; }
let discoveryCache: Promise<Endpoints> | null = null;
export function resetLardCache(): void { discoveryCache = null; }
function discover(): Promise<Endpoints> {
  if (!discoveryCache) {
    discoveryCache = (async () => {
      const base = trimSlash(cfg().baseUrl);
      const prm = await getJSON<{ authorization_servers?: string[] }>(base + "/.well-known/oauth-protected-resource");
      const as = trimSlash(prm.authorization_servers?.[0] ?? "");
      if (!as) throw new Error("lard: the server advertises no authorization server");
      const meta = await getJSON<{ authorization_endpoint?: string; token_endpoint?: string; device_authorization_endpoint?: string }>(as + "/.well-known/oauth-authorization-server");
      if (!meta.token_endpoint || !meta.device_authorization_endpoint) throw new Error("lard: authorization server metadata is missing endpoints");
      return { authorization: meta.authorization_endpoint, token: meta.token_endpoint, deviceAuthorization: meta.device_authorization_endpoint };
    })().catch((e) => { discoveryCache = null; throw e; });
  }
  return discoveryCache;
}

// A configured client id wins; otherwise ask lard which collector client to be.
async function clientId(): Promise<string> {
  if (cfg().clientId) return cfg().clientId;
  const reg = await getJSON<{ client_id?: string }>(trimSlash(cfg().baseUrl) + "/auth/collector");
  if (!reg.client_id) throw new Error("lard: no clientId configured and the server publishes none");
  return reg.client_id;
}

function tokenFrom(j: { access_token: string; refresh_token?: string; expires_in?: number }): LardToken {
  return { accessToken: j.access_token, refreshToken: j.refresh_token || undefined, expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : 0 };
}
async function postForm(url: string, form: URLSearchParams): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(cfg().timeoutMs),
  });
}

// ---- device grant (login) ------------------------------------------------
export interface DeviceStart { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete?: string; interval: number; expiresIn: number; }

async function startDevice(): Promise<DeviceStart> {
  const eps = await discover();
  const form = new URLSearchParams({ client_id: await clientId() });
  if (cfg().scopes) form.set("scope", cfg().scopes);
  const res = await postForm(eps.deviceAuthorization, form);
  const j = (await res.json()) as Record<string, string | number>;
  if (!j.device_code || !j.verification_uri) throw new Error(`lard: device authorization failed (${res.status})`);
  return {
    deviceCode: String(j.device_code), userCode: String(j.user_code ?? ""),
    verificationUri: String(j.verification_uri), verificationUriComplete: j.verification_uri_complete ? String(j.verification_uri_complete) : undefined,
    interval: Number(j.interval) || 5, expiresIn: Number(j.expires_in) || 600,
  };
}

async function pollDevice(deviceCode: string): Promise<{ token?: LardToken; status?: string }> {
  const eps = await discover();
  const form = new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: await clientId() });
  let res: Response;
  try { res = await postForm(eps.token, form); } catch { return { status: "authorization_pending" }; } // transient blip → keep waiting
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (j.error) return { status: j.error };
  if (!j.access_token) throw new Error(`lard: token endpoint returned ${res.status}`);
  return { token: tokenFrom(j as { access_token: string }) };
}

/** Run the device grant to completion. `onPrompt` shows the user the code + URL. */
export async function deviceLogin(onPrompt: (d: DeviceStart) => void): Promise<LardToken> {
  const start = await startDevice();
  onPrompt(start);
  let interval = start.interval;
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const { token, status } = await pollDevice(start.deviceCode);
    if (token) return token;
    if (status === "slow_down") interval += 5;
    else if (status === "authorization_pending") continue;
    else if (status === "access_denied") throw new Error("lard: authorization was declined");
    else if (status && status !== "authorization_pending") throw new Error(`lard: authorization failed (${status})`);
  }
  throw new Error("lard: this login expired; run it again");
}

// ---- token lifecycle (per user) ------------------------------------------
async function refresh(tok: LardToken): Promise<LardToken> {
  if (!tok.refreshToken) throw new Error("lard: access token expired and no refresh token — reconnect");
  const eps = await discover();
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refreshToken, client_id: await clientId() });
  const res = await postForm(eps.token, form);
  const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!res.ok || !j.access_token) throw new Error("lard: refresh was rejected — reconnect");
  return tokenFrom({ access_token: j.access_token, refresh_token: j.refresh_token || tok.refreshToken, expires_in: j.expires_in });
}

/** A valid access token for `sub`, refreshing + persisting within 60s of expiry. Throws if unconnected. */
async function accessToken(store: Store, sub: string): Promise<string> {
  const tok = store.getLardToken(sub);
  if (!tok) throw new Error("lard: not connected");
  if (tok.expiresAt && tok.expiresAt - Date.now() < 60_000) {
    const fresh = await refresh(tok);
    store.setLardToken(sub, fresh);
    return fresh.accessToken;
  }
  return tok.accessToken;
}

async function api<T>(store: Store, sub: string, path: string, init?: RequestInit): Promise<T> {
  const at = await accessToken(store, sub);
  const res = await fetch(trimSlash(cfg().baseUrl) + path, {
    ...init,
    headers: { authorization: `Bearer ${at}`, accept: "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(cfg().timeoutMs),
  });
  if (!res.ok) throw new Error(`lard: ${init?.method ?? "GET"} ${path} → ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

// ---- memory API (paths: profile, areas/<n>, topics/<n>, people/<n>) ------
export interface ContextBundle { profile: string; area?: string; listing: { path: string; title?: string }[]; projectId?: string; }
const cleanPath = (p: string): string => p.replace(/^\/+/, "").replace(/\.\.(\/|$)/g, ""); // no leading slash, no traversal

export function getContext(store: Store, sub: string, project?: string): Promise<ContextBundle> {
  return api(store, sub, "/context" + (project ? "?project=" + encodeURIComponent(project) : ""));
}
export function memoryList(store: Store, sub: string): Promise<unknown> { return api(store, sub, "/memory"); }
export function memoryRead(store: Store, sub: string, path: string): Promise<string> { return api(store, sub, "/memory/" + cleanPath(path)); }
export function memoryWrite(store: Store, sub: string, path: string, body: string): Promise<unknown> {
  return api(store, sub, "/memory/" + cleanPath(path), { method: "PUT", headers: { "content-type": "text/markdown" }, body });
}
export function memoryAppend(store: Store, sub: string, path: string, line: string): Promise<unknown> {
  return api(store, sub, "/memory/" + cleanPath(path), { method: "POST", headers: { "content-type": "text/plain" }, body: line });
}

// ---- in-app connect: authorization code + PKCE ---------------------------
// lard shares kloe's authorization server (indiko), which supports the code
// grant, so linking a user is a browser redirect: /lard/connect → the AS → back
// to /lard/callback, where we exchange the code and store the token under the
// signed-in kloe user's `sub`. Mirrors src/auth.ts's own login flow.
const LARD_COOKIE = "kloe_lard_oauth"; // short-lived: PKCE verifier + state + sub
const b64url = (b: Buffer): string => b.toString("base64url");
function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
function lardCookie(value: string, maxAgeSec: number): string {
  const secure = trimSlash(getConfig().auth.baseUrl).startsWith("https") ? "; Secure" : "";
  return `${LARD_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}
// kloe's OAuth identity to the shared AS: a pre-registered lard.clientId wins,
// else reuse kloe's own client (its auth clientId / CIMD document).
function connectClientId(): string {
  const a = getConfig().auth;
  return cfg().clientId || a.clientId || trimSlash(a.baseUrl) + "/client-metadata.json";
}
const connectRedirectUri = (): string => trimSlash(getConfig().auth.baseUrl) + "/lard/callback";
const redirectTo = (path: string, cookie?: string): Response => {
  const headers = new Headers({ Location: path });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
};

/** GET /lard/connect — start the auth-code + PKCE flow to link this user's lard. */
export async function handleLardConnect(req: Request, store: Store): Promise<Response> {
  if (!lardEnabled()) return new Response("lard is not enabled", { status: 404 });
  const sub = authEnabled() ? getSession(req, store)?.sub : LOCAL_SUB;
  if (authEnabled() && !sub) return redirectTo("/auth/login?returnTo=" + encodeURIComponent("/lard/connect"));
  const eps = await discover();
  if (!eps.authorization) return new Response("lard's authorization server has no authorization endpoint", { status: 400 });
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const url = new URL(eps.authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", connectClientId());
  url.searchParams.set("redirect_uri", connectRedirectUri());
  url.searchParams.set("scope", cfg().scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", trimSlash(cfg().baseUrl)); // RFC 8707: audience = lard
  return redirectTo(url.href, lardCookie(JSON.stringify({ state, verifier, sub: sub ?? LOCAL_SUB }), 600));
}

/** GET /lard/callback — verify state, exchange the code, store the token for this user. */
export async function handleLardCallback(req: Request, store: Store): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  let saved: { state?: string; verifier?: string; sub?: string } = {};
  try { saved = JSON.parse(parseCookies(req)[LARD_COOKIE] ?? "{}"); } catch { /* malformed cookie */ }
  const clear = lardCookie("", 0);
  const back = (ok: boolean) => redirectTo("/settings?lard=" + (ok ? "connected" : "error"), clear);
  if (!code || !state || !saved.state || state !== saved.state) return back(false);
  try {
    const eps = await discover();
    const res = await postForm(eps.token, new URLSearchParams({
      grant_type: "authorization_code", code,
      client_id: connectClientId(), redirect_uri: connectRedirectUri(),
      code_verifier: saved.verifier ?? "",
    }));
    const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!res.ok || !j.access_token) return back(false);
    store.setLardToken(saved.sub || LOCAL_SUB, tokenFrom(j as { access_token: string }));
    return back(true);
  } catch { return back(false); }
}

/** Disconnect this user's lard (drop their token). */
export function lardDisconnect(store: Store, sub: string): void { store.deleteLardToken(sub); }

// ---- ingest --------------------------------------------------------------
export interface IngestTurn { index: number; role: string; content: string; ts: string; }
export interface IngestSession { sessionId: string; source: string; startedAt: string; endedAt?: string; projectHints?: Record<string, unknown>; turns: IngestTurn[]; }
export function ingest(store: Store, sub: string, sessions: IngestSession[]): Promise<unknown> {
  return api(store, sub, "/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ collector: cfg().collector, sessions }) });
}
