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
   * Read a credential file the user pasted, for a flow that has no `start`.
   * Throws with something a person can act on when it isn't what it should be.
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
 * OpenAI's Codex, as the CLI holds it: an access token, a refresh token and the
 * ChatGPT account id, kept in ~/.codex/auth.json. kloe can refresh it (that
 * endpoint takes only the client id, which is public) but cannot obtain the
 * first one, because the client's registered redirect is localhost:1455.
 */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TIMEOUT_MS = 15_000;
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
  parse(pasted) {
    let file: {
      auth_mode?: string;
      OPENAI_API_KEY?: string | null;
      tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
    };
    try {
      file = JSON.parse(pasted);
    } catch {
      throw new Error("that is not JSON — paste the whole contents of ~/.codex/auth.json");
    }
    const tokens = file.tokens;
    if (!tokens?.access_token || !tokens.refresh_token) {
      throw new Error(
        file.OPENAI_API_KEY
          ? "that file holds an API key rather than a ChatGPT sign-in; paste the key into the OpenAI row instead"
          : "no tokens in that file — run `codex login` first",
      );
    }
    return {
      pair: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: jwtExpiry(tokens.access_token),
      },
      // The account id is a header on every request, not a secret; without it
      // the endpoint answers 401 however good the token is.
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
