/*
 * Client for hyper's device authorization flow (charm.land/hyper), so a kloe
 * user can spend their own hyper credits instead of the deployment's key.
 *
 * Three steps, mirroring RFC 8628 with hyper's own spelling:
 *   1. POST /device/auth               → device_code + a user_code to type in
 *   2. GET  /device/auth/{device_code} → "authorization_pending" until the user
 *      approves in a browser and picks a team, then a ONE-TIME refresh token
 *   3. POST /token/exchange            → a 60-minute access token, plus a NEW
 *      refresh token; the one you sent is revoked in the same breath.
 *
 * That rotation is the thing to be careful about. A refresh token spends
 * itself: if kloe exchanges one and loses the result (crash, two processes
 * racing, a write that didn't land), the user's connection is gone and they
 * have to approve a new device. Every caller here persists the new pair before
 * doing anything else with it, and the store's refresh lease keeps two
 * processes from exchanging the same token twice.
 *
 * The endpoints live at the app root, NOT under the /v1 inference path, which
 * is why the provider config carries `oauth.baseUrl` separately from
 * `apiEndpoint`.
 */

const TIMEOUT_MS = 15_000;
const trimSlash = (s: string): string => s.replace(/\/+$/, "");

/** The verification page with the code in its query, or undefined if the URL won't parse. */
function withUserCode(verificationUrl: string, userCode: string): string | undefined {
  try {
    const url = new URL(verificationUrl);
    url.searchParams.set("user_code", userCode);
    return url.toString();
  } catch {
    return undefined;
  }
}

export interface DeviceStart {
  deviceCode: string;
  /** What the user types on the verification page, formatted for reading aloud. */
  userCode: string;
  verificationUrl: string;
  /**
   * The same page with the code already in the box (RFC 8628 calls this
   * `verification_uri_complete`). Where it exists, approving is two clicks and
   * no typing; the code stays on screen anyway, for approving on a phone.
   */
  verificationUrlComplete?: string;
  /** Epoch ms after which the code is dead. */
  expiresAt: number;
}

export interface DeviceGrant {
  refreshToken: string;
  teamName?: string;
  teamId?: string;
  userId?: string;
}

/** Where a device authorization has got to. `pending` is the normal case. */
export type DevicePoll =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "granted"; grant: DeviceGrant };

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

async function post(url: string, body: unknown, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`hyper: ${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

/** Step 1: ask for a code the user can type in. */
export async function startDeviceAuth(
  baseUrl: string,
  deviceName = "kloe",
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceStart> {
  const data = (await post(
    `${trimSlash(baseUrl)}/device/auth`,
    { device_name: deviceName },
    fetchImpl,
  )) as {
    device_code?: string;
    user_code?: string;
    verification_url?: string;
    expires_in?: number;
  };
  if (!data.device_code || !data.user_code) throw new Error("hyper: device auth returned no code");
  const verificationUrl = data.verification_url ?? `${trimSlash(baseUrl)}/device/authed/verify`;
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl,
    // hyper's verify page reads ?user_code and renders it into the field, so
    // the link can carry it. It does not advertise a complete URL of its own,
    // which is why this is built rather than read.
    verificationUrlComplete: withUserCode(verificationUrl, data.user_code),
    expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
  };
}

/**
 * Step 2: has the user approved yet?
 *
 * Hyper answers 200 with an `error` field for every not-yet state, so the
 * status lives in the body rather than in the HTTP code. A grant comes back
 * exactly once — the server clears its copy as it hands it over, so a second
 * poll after success returns `invalid_grant`, which is treated as expired
 * rather than as a retry.
 */
export async function pollDeviceAuth(
  baseUrl: string,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DevicePoll> {
  const res = await fetchImpl(
    `${trimSlash(baseUrl)}/device/auth/${encodeURIComponent(deviceCode)}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (res.status === 404) return { status: "expired" };
  if (!res.ok) throw new Error(`hyper: device poll → ${res.status}`);
  const data = (await res.json()) as {
    error?: string;
    refresh_token?: string;
    team_name?: string;
    team_id?: string;
    user_id?: string;
  };
  if (data.error === "authorization_pending") return { status: "pending" };
  if (data.error === "access_denied") return { status: "denied" };
  if (data.error) return { status: "expired" }; // expired_token, invalid_grant, anything else
  if (!data.refresh_token) return { status: "pending" };
  return {
    status: "granted",
    grant: {
      refreshToken: data.refresh_token,
      teamName: data.team_name,
      teamId: data.team_id,
      userId: data.user_id,
    },
  };
}

/**
 * Step 3: trade a refresh token for an access token and its replacement.
 *
 * The caller MUST persist the returned pair before using the access token: the
 * token passed in is revoked by this call, so a result that isn't stored is a
 * connection thrown away.
 */
export async function exchangeToken(
  baseUrl: string,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenPair> {
  const data = (await post(
    `${trimSlash(baseUrl)}/token/exchange`,
    { refresh_token: refreshToken },
    fetchImpl,
  )) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token || !data.refresh_token) {
    throw new Error("hyper: token exchange returned an incomplete pair");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}
