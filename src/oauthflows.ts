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

export interface DeviceFlow {
  /** Ask the provider for a code the user types in, and where to type it. */
  start(baseUrl: string, deviceName: string, fetchImpl?: typeof fetch): Promise<DeviceStart>;
  /** Has the user approved it yet? */
  poll(baseUrl: string, deviceCode: string, fetchImpl?: typeof fetch): Promise<DevicePoll>;
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

export const FLOWS: Record<string, DeviceFlow> = {
  "hyper-device": hyperDevice,
};

/** The named flow, or undefined — a config naming one kloe doesn't implement. */
export function flowFor(name: string): DeviceFlow | undefined {
  return FLOWS[name];
}

export function flowNames(): string[] {
  return Object.keys(FLOWS);
}
