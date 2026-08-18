/**
 * Services kloe knows how to connect a USER to, whether or not this deployment
 * runs them itself.
 *
 * The point is that an OAuth connection costs an operator nothing. Where a
 * pasted key needs somewhere to send it, a device flow already carries its own
 * address, and the credits it spends are the user's — so an instance that never
 * configured hyper can still let someone bring their hyper account. Requiring
 * config for that would be asking an operator to opt in on behalf of somebody
 * else's money.
 *
 * A leaf module on purpose: the provider registry and the connector list both
 * read it, and neither should have to import the other to learn where hyper is.
 */

export interface WellKnownProvider {
  service: "inference";
  id: string;
  /** Adapter/enricher hint, same vocabulary as ops config. */
  type: string;
  /** The inference API base. */
  apiEndpoint: string;
  /** The device flow, and the app root its endpoints live at. */
  oauth: { flow: string; baseUrl: string };
}

export const WELL_KNOWN: WellKnownProvider[] = [
  {
    service: "inference",
    id: "hyper",
    type: "hyper",
    apiEndpoint: "https://hyper.charm.land/v1",
    oauth: { flow: "hyper-device", baseUrl: "https://hyper.charm.land" },
  },
];

export function wellKnownProvider(id: string): WellKnownProvider | undefined {
  return WELL_KNOWN.find((p) => p.id === id);
}
