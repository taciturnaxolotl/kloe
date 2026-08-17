import { exchangeToken } from "./hyperauth";
import { decryptSecret, encryptionConfigured, encryptSecret, hint } from "./secrets";
import { getConfig } from "./settings";
import type { CredentialRow, Store, UserCredential } from "./store";

/**
 * Credentials that belong to a user rather than to the deployment.
 *
 * Two ways in — a pasted API key, or an OAuth grant the user ran (hyper's
 * device flow) — and one way out: `credentialFor(store, sub, providerId)`
 * returns the bearer string to send, or undefined to mean "this user has
 * nothing of their own, use the deployment's key". Everything above this module
 * only sees that one answer, which is what keeps the run path from growing a
 * second notion of who is paying.
 *
 * The refresh is the interesting part. Hyper's access tokens last an hour and
 * every exchange rotates the refresh token, revoking the old one, so two
 * processes refreshing at once would leave one of them holding a dead token and
 * the user disconnected. A lease in the row makes exactly one of them do the
 * work; the other waits briefly and re-reads what it wrote.
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
    providerId: row.provider_id,
    kind: row.kind === "oauth" ? "oauth" : "key",
    secret: decryptSecret(row.secret),
    refreshToken: row.refresh_token ? decryptSecret(row.refresh_token) : undefined,
    expiresAt: row.expires_at ?? undefined,
    label: row.label ?? undefined,
    updatedAt: row.updated_at,
  };
}

/** The provider entry from ops config, or undefined if it isn't enabled here. */
function providerConfig(providerId: string) {
  return getConfig().providers.find((p) => p.id === providerId);
}

/** Whether a user may paste their own key for this provider. */
export function byokAllowed(providerId: string): boolean {
  const p = providerConfig(providerId);
  return !!p && p.byok !== false && encryptionConfigured();
}

/** The OAuth flow a user can run for this provider, if it offers one. */
export function oauthFlow(providerId: string) {
  const p = providerConfig(providerId);
  return p?.oauth && encryptionConfigured() ? p.oauth : undefined;
}

/** Providers a user could connect something to, for the settings page. */
export function connectableProviders(): Array<{
  id: string;
  byok: boolean;
  oauth: boolean;
}> {
  if (!encryptionConfigured()) return [];
  return getConfig()
    .providers.map((p) => ({ id: p.id, byok: p.byok !== false, oauth: !!p.oauth }))
    .filter((p) => p.byok || p.oauth);
}

export function saveApiKey(store: Store, sub: string, providerId: string, apiKey: string): void {
  if (!byokAllowed(providerId)) {
    throw new Error(`provider "${providerId}" does not accept a user-supplied key here`);
  }
  store.setCredentialRow({
    sub,
    provider_id: providerId,
    kind: "key",
    secret: encryptSecret(apiKey),
    refresh_token: null,
    expires_at: null,
    label: hint(apiKey),
  });
}

/** Store a fresh OAuth grant. Called with the pair an exchange just produced. */
export function saveOAuthGrant(
  store: Store,
  sub: string,
  providerId: string,
  pair: { accessToken: string; refreshToken: string; expiresAt: number },
  label?: string,
): void {
  store.setCredentialRow({
    sub,
    provider_id: providerId,
    kind: "oauth",
    secret: encryptSecret(pair.accessToken),
    refresh_token: encryptSecret(pair.refreshToken),
    expires_at: pair.expiresAt,
    label: label ?? null,
  });
}

export function disconnect(store: Store, sub: string, providerId: string): void {
  store.deleteCredential(sub, providerId);
}

/** What the settings page shows: which providers this user has connected, and how. */
export function listConnections(
  store: Store,
  sub: string,
): Array<{ providerId: string; kind: "key" | "oauth"; label?: string; expiresAt?: number }> {
  return store.listCredentialRows(sub).map((r) => ({
    providerId: r.provider_id,
    kind: r.kind === "oauth" ? "oauth" : "key",
    label: r.label ?? undefined,
    expiresAt: r.expires_at ?? undefined,
  }));
}

/**
 * The bearer string to use for this user and provider, or undefined when they
 * have none and the deployment's own key should be used.
 *
 * Never throws on a broken connection: a revoked or unrefreshable credential
 * resolves to undefined, so the run falls back to the shared key rather than
 * failing outright. The user sees "disconnected" in settings, not an error in
 * the middle of a sentence.
 */
export async function credentialFor(
  store: Store,
  sub: string | undefined,
  providerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  if (!sub || !encryptionConfigured()) return undefined;
  const row = store.getCredentialRow(sub, providerId);
  if (!row) return undefined;

  let cred: UserCredential;
  try {
    cred = decode(row);
  } catch {
    // Ciphertext we can't read (the key changed, or the row is corrupt). Falling
    // back is right: the alternative is every run for this user failing.
    console.warn(`[credentials] unreadable credential for ${providerId}; ignoring`);
    return undefined;
  }

  if (cred.kind === "key") return cred.secret;
  if (cred.expiresAt && cred.expiresAt - REFRESH_SKEW_MS > Date.now()) return cred.secret;
  return refresh(store, cred, fetchImpl);
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
  const flow = oauthFlow(cred.providerId);
  if (!flow || !cred.refreshToken) return undefined;

  const now = Date.now();
  if (!store.claimRefresh(cred.sub, cred.providerId, now, now + REFRESH_LEASE_MS)) {
    return waitForRefresh(store, cred);
  }

  try {
    const pair = await exchangeToken(flow.baseUrl, cred.refreshToken, fetchImpl);
    // Persist BEFORE returning: the token we just spent is already revoked, so
    // an unsaved result is a connection thrown away.
    saveOAuthGrant(store, cred.sub, cred.providerId, pair, cred.label);
    return pair.accessToken;
  } catch (e) {
    // The grant is gone (revoked, expired, or hyper said no). Drop the row so
    // the user is told to reconnect instead of every run retrying a dead token.
    console.warn(`[credentials] ${cred.providerId} refresh failed:`, (e as Error).message);
    store.deleteCredential(cred.sub, cred.providerId);
    return undefined;
  }
}

async function waitForRefresh(store: Store, cred: UserCredential): Promise<string | undefined> {
  for (let waited = 0; waited < WAIT_MAX_MS; waited += WAIT_STEP_MS) {
    await sleep(WAIT_STEP_MS);
    const row = store.getCredentialRow(cred.sub, cred.providerId);
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
