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
  /** What to call it in a list, when the id is not what people say. */
  label?: string;
  /** Adapter/enricher hint, same vocabulary as ops config. */
  type: string;
  /** The inference API base. */
  apiEndpoint: string;
  /** A device flow a user can run here, for providers that offer one. */
  oauth?: { flow: string; baseUrl: string };
  /**
   * A credential a local tool already holds, for whoever cannot use the device
   * flow. Shown as a fallback, not a second front door.
   */
  paste?: { flow: string; label: string; help: string };
  /**
   * Whether a pasted API key is also a way in. True for most: a key and a
   * sign-in are different credentials and people hold one or the other. False
   * where the provider has no key to hold — a ChatGPT subscription is reached
   * by signing in, and an OpenAI API key is a different provider entirely.
   */
  byok?: boolean;
  /**
   * Models this provider serves that nothing enumerates. Discovery is the
   * better answer where an endpoint exists; this is for the ones where it
   * doesn't.
   */
  models?: Array<{ id: string; name: string }>;
}

export const WELL_KNOWN: WellKnownProvider[] = [
  {
    service: "inference",
    id: "hyper",
    type: "hyper",
    apiEndpoint: "https://hyper.charm.land/v1",
    oauth: { flow: "hyper-device", baseUrl: "https://hyper.charm.land" },
  },
  {
    // A ChatGPT subscription, through the endpoint the Codex CLI uses, signed
    // into with the device flow `codex login --device-auth` runs. None of it is
    // documented — the issuer's discovery advertises no device endpoint — but
    // the CLI is open source and the endpoints answer.
    service: "inference",
    id: "codex",
    label: "ChatGPT (Codex)",
    type: "openai-responses",
    apiEndpoint: "https://chatgpt.com/backend-api/codex",
    oauth: { flow: "codex", baseUrl: "https://auth.openai.com" },
    // Device sign-in is a workspace setting an admin can switch off. When they
    // have, the browser flow still works on the user's own machine, so what it
    // stored is the way in.
    paste: {
      flow: "codex",
      label: "Paste ~/.codex/auth.json",
      help: "Device sign-in blocked? Run `codex login` on your own machine and paste ~/.codex/auth.json here.",
    },
    byok: false,
    // This endpoint enumerates nothing, and what a ChatGPT plan may run is not
    // what an API key may run: asking for a model outside the list is a 400
    // saying so.
    models: [
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    ],
  },
];

export function wellKnownProvider(id: string): WellKnownProvider | undefined {
  return WELL_KNOWN.find((p) => p.id === id);
}
