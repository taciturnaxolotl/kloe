import {
  type DevicePoll,
  type DeviceStart,
  exchangeToken,
  pollDeviceAuth,
  startDeviceAuth,
  type TokenPair,
} from "./hyperauth";

/**
 * The OAuth flows a user can run to connect their own account.
 *
 * A flow is three calls — start, poll, exchange — and a provider entry names
 * one by string. Everything above this module (credentials.ts, the HTTP
 * endpoints, the settings page) works in terms of the interface, so a second
 * provider is a new entry in FLOWS rather than an edit to the refresh path.
 *
 * Device flows only, so far, and that is not an accident: kloe holds the
 * credential on the user's behalf and never sees their password, and a device
 * code is the shape that works when the thing being authorized is a server
 * rather than the browser in front of them.
 */

/** What a pasted credential file yields: a grant, plus whatever else it carries. */
export interface ParsedGrant {
  pair: TokenPair;
  /** Provider-specific bits a request needs later, e.g. an account id. */
  meta?: Record<string, string>;
  label?: string;
}

export interface DeviceFlow {
  /**
   * Ask the provider for a code the user types in, and where to type it.
   * Absent for a provider kloe cannot sign into on the user's behalf.
   */
  start?(baseUrl: string, deviceName: string, fetchImpl?: typeof fetch): Promise<DeviceStart>;
  /** Has the user approved it yet? */
  poll?(baseUrl: string, deviceCode: string, fetchImpl?: typeof fetch): Promise<DevicePoll>;
  /**
   * Read a credential file a local tool already holds, for whoever cannot use
   * `start` — a workspace can switch device sign-in off, and then this is the
   * only way in. Throws with something a person can act on.
   */
  parse?(pasted: string): ParsedGrant;
  /**
   * Trade a refresh token for an access token and its replacement.
   *
   * Implementations MUST return the new refresh token when the provider
   * rotates: the caller persists the pair before using it, because a rotated
   * token that isn't stored is a connection thrown away.
   */
  exchange(baseUrl: string, refreshToken: string, fetchImpl?: typeof fetch): Promise<TokenPair>;
}

const hyperDevice: DeviceFlow = {
  start: (baseUrl, deviceName, fetchImpl) => startDeviceAuth(baseUrl, deviceName, fetchImpl),
  poll: (baseUrl, deviceCode, fetchImpl) => pollDeviceAuth(baseUrl, deviceCode, fetchImpl),
  exchange: (baseUrl, refreshToken, fetchImpl) => exchangeToken(baseUrl, refreshToken, fetchImpl),
};

/**
 * OpenAI's Codex device flow, the one `codex login --device-auth` runs.
 *
 * Three steps rather than two, because the middle one hands back an
 * authorization code instead of tokens:
 *
 *   1. POST /api/accounts/deviceauth/usercode → a code and a poll interval
 *   2. the user enters it at {issuer}/codex/device
 *   3. POST /api/accounts/deviceauth/token → 403/404 while pending, then
 *      `{authorization_code, code_verifier, code_challenge}` — the server
 *      generated the PKCE pair itself, so whoever polls can finish the
 *      exchange, which is what makes this usable from a server at all.
 *
 * Nothing here is documented: the issuer's discovery document advertises no
 * device endpoint and only the authorization-code and refresh-token grants.
 * It is all in the CLI, which is open source, and the endpoints answer.
 */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
const TIMEOUT_MS = 15_000;

/** A claim OpenAI nests under a namespaced key in the id token. */
function chatgptAccountId(idToken: string): string | undefined {
  try {
    const part = idToken.split(".")[1] ?? "";
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
      string,
      { chatgpt_account_id?: string } | undefined
    >;
    return claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Seconds until a JWT's `exp`, or a conservative hour when it won't parse. */
function jwtExpiry(token: string): number {
  try {
    const part = token.split(".")[1] ?? "";
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number };
    return claims.exp ? claims.exp * 1000 : Date.now() + 3_600_000;
  } catch {
    return Date.now() + 3_600_000;
  }
}

const codex: DeviceFlow = {
  async start(_baseUrl, _deviceName, fetchImpl = fetch) {
    const res = await fetchImpl(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // 404 is "not enabled here"; 403 is a workspace that has switched it off.
      // Either way the fallback below is the answer, so say so.
      const detail = await res.text().catch(() => "");
      throw new Error(
        /admin|enable|not enabled/i.test(detail) || res.status === 403 || res.status === 404
          ? "your workspace has device sign-in turned off"
          : `codex: device code → ${res.status}`,
      );
    }
    const data = (await res.json()) as {
      device_auth_id?: string;
      user_code?: string;
      interval?: string | number;
    };
    if (!data.device_auth_id || !data.user_code) {
      throw new Error("codex: device code response was incomplete");
    }
    return {
      // Both halves are needed to poll, and the poll takes one string: they
      // travel together and split on the way back out.
      deviceCode: `${data.device_auth_id}:${data.user_code}`,
      userCode: data.user_code,
      verificationUrl: `${CODEX_ISSUER}/codex/device`,
      // No complete URL: the page takes the code by hand, and OpenAI's own
      // prompt tells people to cancel if a code arrived from anywhere else.
      expiresAt: Date.now() + 15 * 60_000,
    };
  },

  async poll(_baseUrl, deviceCode, fetchImpl = fetch) {
    const [deviceAuthId, userCode] = deviceCode.split(":");
    if (!deviceAuthId || !userCode) return { status: "expired" };

    const res = await fetchImpl(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Pending is a 403 or a 404 here, not a body with an error in it.
    if (res.status === 403 || res.status === 404) return { status: "pending" };
    if (!res.ok) throw new Error(`codex: device poll → ${res.status}`);

    const code = (await res.json()) as { authorization_code?: string; code_verifier?: string };
    if (!code.authorization_code || !code.code_verifier) return { status: "pending" };

    // The approval yields a code, and the verifier to spend it with. Trading it
    // here rather than handing both back keeps PKCE's two halves in one place.
    const token = await fetchImpl(`${CODEX_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code.authorization_code,
        redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
        client_id: CODEX_CLIENT_ID,
        code_verifier: code.code_verifier,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!token.ok) throw new Error(`codex: token exchange → ${token.status}`);
    const tokens = (await token.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error("codex: token exchange returned an incomplete pair");
    }
    const accountId = tokens.id_token ? chatgptAccountId(tokens.id_token) : undefined;
    return {
      status: "granted",
      grant: {
        refreshToken: tokens.refresh_token,
        tokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_in
            ? Date.now() + tokens.expires_in * 1000
            : jwtExpiry(tokens.access_token),
        },
        // The endpoint answers 401 without this, however good the token is.
        meta: accountId ? { accountId } : undefined,
        teamName: "ChatGPT account",
      },
    };
  },

  /**
   * The fallback: what `codex login` wrote on the user's own machine.
   *
   * Device sign-in is a workspace setting, and an admin can turn it off — the
   * endpoint then says so and there is nothing kloe can do about it. The
   * browser flow still works locally, so the tokens it stored are still a way
   * in, and refreshing them afterwards needs only the public client id.
   */
  parse(pasted) {
    let file: {
      auth_mode?: string;
      OPENAI_API_KEY?: string | null;
      tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
    };
    try {
      file = JSON.parse(pasted);
    } catch {
      throw new Error("that is not JSON; paste the whole contents of ~/.codex/auth.json");
    }
    const tokens = file.tokens;
    if (!tokens?.access_token || !tokens.refresh_token) {
      throw new Error(
        file.OPENAI_API_KEY
          ? "that file holds an API key rather than a ChatGPT sign-in; paste the key into the OpenAI row instead"
          : "no tokens in that file; run `codex login` first",
      );
    }
    return {
      pair: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: jwtExpiry(tokens.access_token),
      },
      // A header on every request, not a secret; without it the endpoint
      // answers 401 however good the token is.
      meta: tokens.account_id ? { accountId: tokens.account_id } : undefined,
      label: file.auth_mode === "chatgpt" ? "ChatGPT account" : file.auth_mode,
    };
  },

  async exchange(_baseUrl, refreshToken, fetchImpl = fetch) {
    const res = await fetchImpl(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: "openid profile email",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`codex: refresh → ${res.status} ${await res.text()}`);
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) throw new Error("codex: refresh returned no access token");
    return {
      accessToken: data.access_token,
      // OpenAI may or may not rotate it; keeping the old one when it doesn't is
      // the difference between a connection that lasts and one that expires.
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : jwtExpiry(data.access_token),
    };
  },
};

export const FLOWS: Record<string, DeviceFlow> = {
  "hyper-device": hyperDevice,
  codex,
};

/** The named flow, or undefined — a config naming one kloe doesn't implement. */
export function flowFor(name: string): DeviceFlow | undefined {
  return FLOWS[name];
}

export function flowNames(): string[] {
  return Object.keys(FLOWS);
}
