import { type Connector, findConnector, listConnectors, type Service } from "./connectors";
import { flowFor } from "./oauthflows";
import { decryptSecret, encryptionConfigured, encryptSecret, hint } from "./secrets";
import type { CredentialRow, Store, UserCredential } from "./store";

/**
 * Credentials that belong to a user rather than to the deployment.
 *
 * Two ways in — a pasted API key, or an OAuth grant the user ran — and one way
 * out: `credentialFor(store, sub, service, providerId)` returns the bearer
 * string to send, or undefined to mean "this user has nothing of their own, use
 * the deployment's". Everything above this module only sees that one answer,
 * which is what keeps the run path from growing a second notion of who is
 * paying.
 *
 * Nothing here knows what a provider IS. It asks the connector registry where
 * one lives and which flow it speaks, so adding a service (search, after
 * inference) or a provider (anything catwalk lists) touches neither this file
 * nor the run path.
 *
 * The refresh is the interesting part. Access tokens are short-lived and hyper
 * rotates the refresh token on every exchange, revoking the old one, so two
 * processes refreshing at once would leave one holding a dead token and the
 * user disconnected. A lease in the row makes exactly one of them do the work;
 * the other waits briefly and reads what it wrote.
 */

/** Refresh this far ahead of expiry, so a token can't die mid-request. */
const REFRESH_SKEW_MS = 60_000;
/** How long a refresher may hold the lease before another may take it over. */
const REFRESH_LEASE_MS = 30_000;
/** How long a loser of the race waits for the winner's result. */
const WAIT_STEP_MS = 250;
const WAIT_MAX_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function decode(row: CredentialRow): UserCredential {
  return {
    sub: row.sub,
    service: row.service as Service,
    providerId: row.provider_id,
    kind: row.kind === "oauth" ? "oauth" : "key",
    secret: decryptSecret(row.secret),
    refreshToken: row.refresh_token ? decryptSecret(row.refresh_token) : undefined,
    expiresAt: row.expires_at ?? undefined,
    label: row.label ?? undefined,
    meta: parseMeta(row.meta),
    updatedAt: row.updated_at,
  };
}

function parseMeta(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a user may paste their own key here. */
export function byokAllowed(service: Service, providerId: string): boolean {
  return findConnector(service, providerId)?.byok === true;
}

/** The OAuth flow a user can run for this provider, if it offers one kloe speaks. */
export function oauthFlow(service: Service, providerId: string): Connector["oauth"] {
  const oauth = findConnector(service, providerId)?.oauth;
  return oauth && flowFor(oauth.flow) ? oauth : undefined;
}

/** Everything a user could connect an account to, for the settings page. */
export function connectableProviders(): Connector[] {
  return listConnectors().filter((c) => c.byok || c.oauth || c.paste);
}

export function saveApiKey(
  store: Store,
  sub: string,
  service: Service,
  providerId: string,
  apiKey: string,
): void {
  if (!byokAllowed(service, providerId)) {
    throw new Error(`${service} provider "${providerId}" does not accept a user-supplied key here`);
  }
  store.setCredentialRow({
    sub,
    service,
    provider_id: providerId,
    kind: "key",
    secret: encryptSecret(apiKey),
    refresh_token: null,
    expires_at: null,
    label: hint(apiKey),
    meta: null,
  });
}

/**
 * Store a credential a user pasted from a tool on their own machine.
 *
 * The flow parses it, so what counts as valid — and what to say when it isn't —
 * belongs to whoever knows that provider rather than here.
 */
export function saveTokenBundle(
  store: Store,
  sub: string,
  service: Service,
  providerId: string,
  pasted: string,
): void {
  const connector = findConnector(service, providerId);
  const flow = connector?.paste && flowFor(connector.paste.flow);
  if (!flow?.parse) throw new Error(`"${providerId}" is not connected by pasting a credential`);
  const parsed = flow.parse(pasted);
  saveOAuthGrant(store, sub, service, providerId, parsed.pair, parsed.label, parsed.meta);
}

/** Store a fresh OAuth grant. Called with the pair an exchange just produced. */
export function saveOAuthGrant(
  store: Store,
  sub: string,
  service: Service,
  providerId: string,
  pair: { accessToken: string; refreshToken: string; expiresAt: number },
  label?: string,
  meta?: Record<string, string>,
): void {
  store.setCredentialRow({
    sub,
    service,
    provider_id: providerId,
    kind: "oauth",
    secret: encryptSecret(pair.accessToken),
    refresh_token: encryptSecret(pair.refreshToken),
    expires_at: pair.expiresAt,
    label: label ?? null,
    // Not encrypted: an account id is an identifier the provider puts in a
    // header, not a thing that grants anything on its own.
    meta: meta ? JSON.stringify(meta) : null,
  });
}

export function disconnect(store: Store, sub: string, service: Service, providerId: string): void {
  store.deleteCredential(sub, service, providerId);
}

export interface Connection {
  service: Service;
  providerId: string;
  kind: "key" | "oauth";
  label?: string;
  expiresAt?: number;
}

/** What the settings page shows: which accounts this user has connected, and how. */
export function listConnections(store: Store, sub: string): Connection[] {
  return store.listCredentialRows(sub).map((r) => ({
    service: r.service as Service,
    providerId: r.provider_id,
    kind: r.kind === "oauth" ? "oauth" : "key",
    label: r.label ?? undefined,
    expiresAt: r.expires_at ?? undefined,
  }));
}

/** Which providers of a service this user pays for themselves. */
export function connectedProviders(
  store: Store,
  sub: string | undefined,
  service: Service,
): string[] {
  if (!sub) return [];
  return store.listCredentialRows(sub, service).map((r) => r.provider_id);
}

/** What a request needs to act as this user: the secret, and anything beside it. */
export interface Credential {
  secret: string;
  meta?: Record<string, string>;
}

/**
 * The credential to use for this user and provider, or undefined when they
 * have none and the deployment's own should be used.
 *
 * Never throws on a broken connection: a revoked or unrefreshable credential
 * resolves to undefined, so the run falls back rather than failing outright.
 * The user sees "disconnected" in settings, not an error mid-sentence.
 */
export async function credentialFor(
  store: Store,
  sub: string | undefined,
  service: Service,
  providerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Credential | undefined> {
  if (!sub || !encryptionConfigured()) return undefined;
  const row = store.getCredentialRow(sub, service, providerId);
  if (!row) return undefined;

  let cred: UserCredential;
  try {
    cred = decode(row);
  } catch {
    // Ciphertext we can't read (the key changed, or the row is corrupt). Falling
    // back is right: the alternative is every run for this user failing.
    console.warn(`[credentials] unreadable ${service} credential for ${providerId}; ignoring`);
    return undefined;
  }

  if (cred.kind === "key") return { secret: cred.secret };
  if (cred.expiresAt && cred.expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return { secret: cred.secret, meta: cred.meta };
  }
  const refreshed = await refresh(store, cred, fetchImpl);
  return refreshed ? { secret: refreshed, meta: cred.meta } : undefined;
}

/**
 * Exchange the refresh token for a new pair, once, across every process.
 *
 * The loser of the lease doesn't refresh and doesn't fail — it waits for the
 * winner to write the new token and reads that, because the token it holds is
 * the one the winner is in the middle of revoking.
 */
async function refresh(
  store: Store,
  cred: UserCredential,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const connector = findConnector(cred.service, cred.providerId);
  const flow = connector?.oauth ? flowFor(connector.oauth.flow) : undefined;
  const baseUrl = connector?.oauth?.baseUrl ?? "";
  if (!flow || !cred.refreshToken) return undefined;

  const now = Date.now();
  if (!store.claimRefresh(cred.sub, cred.service, cred.providerId, now, now + REFRESH_LEASE_MS)) {
    return waitForRefresh(store, cred);
  }

  try {
    const pair = await flow.exchange(baseUrl, cred.refreshToken, fetchImpl);
    // Persist BEFORE returning: a rotated token we didn't store is a connection
    // thrown away.
    saveOAuthGrant(store, cred.sub, cred.service, cred.providerId, pair, cred.label, cred.meta);
    return pair.accessToken;
  } catch (e) {
    // The grant is gone (revoked, expired, or the provider said no). Drop the
    // row so the user is told to reconnect instead of every run retrying a dead
    // token.
    console.warn(`[credentials] ${cred.providerId} refresh failed:`, (e as Error).message);
    store.deleteCredential(cred.sub, cred.service, cred.providerId);
    return undefined;
  }
}

async function waitForRefresh(store: Store, cred: UserCredential): Promise<string | undefined> {
  for (let waited = 0; waited < WAIT_MAX_MS; waited += WAIT_STEP_MS) {
    await sleep(WAIT_STEP_MS);
    const row = store.getCredentialRow(cred.sub, cred.service, cred.providerId);
    if (!row) return undefined; // the winner found the grant dead and dropped it
    if (row.updated_at > cred.updatedAt) {
      try {
        return decryptSecret(row.secret);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
