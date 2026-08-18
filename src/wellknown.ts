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
   * Connect by pasting a credential a tool on your own machine already holds.
   *
   * For providers whose OAuth client only redirects to localhost — a server
   * cannot be the redirect target, and registering a second client is not on
   * offer — so the honest path is to let the local tool do the sign-in and
   * hand kloe what it got.
   */
  paste?: { flow: string; label: string; help: string };
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
    // A ChatGPT subscription, through the endpoint the Codex CLI uses. The
    // sign-in is OpenAI's, and its client redirects only to localhost:1455 —
    // so kloe cannot run it, and instead takes what `codex login` already
    // stored. It refreshes from there on its own.
    service: "inference",
    id: "codex",
    label: "ChatGPT (Codex)",
    type: "openai-responses",
    apiEndpoint: "https://chatgpt.com/backend-api/codex",
    paste: {
      flow: "codex",
      label: "Paste ~/.codex/auth.json",
      help: "Run `codex login` on your own machine, then paste the contents of ~/.codex/auth.json.",
    },
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
