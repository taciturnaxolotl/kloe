import { getCatalog } from "./inference";
import { flowFor } from "./oauthflows";
import { encryptionConfigured } from "./secrets";
import { getConfig, resolveRef } from "./settings";

/**
 * Everything a user can connect an account to, in one vocabulary.
 *
 * kloe spends money in two places — inference and web search — and a user
 * should be able to pay for either one themselves. Rather than teach the
 * credential layer about each, a connector says the three things that layer
 * needs: where the provider lives, whether a pasted key is accepted, and which
 * OAuth flow (if any) a user can run.
 *
 * The service is part of a credential's identity, not a suffix on its name.
 * "exa" is a search engine and could tomorrow be an inference endpoint, and two
 * credentials called `exa` that mean different things is exactly the bug that
 * key would hide.
 */

export type Service = "inference" | "search";
export const SERVICES: Service[] = ["inference", "search"];

export interface OAuthFlowRef {
  flow: string;
  baseUrl: string;
}

export interface Connector {
  service: Service;
  /** Provider id within the service — "hyper", "exa". */
  id: string;
  /** Whether a user may paste their own API key here. */
  byok: boolean;
  /** The device flow a user can run, when the provider offers one. */
  oauth?: OAuthFlowRef;
  /** Where the provider's API lives, for a per-user client. */
  endpoint?: string;
  /** Adapter/type hint, for a per-user client. */
  type?: string;
  /**
   * True when the deployment does not enable this provider itself and a user's
   * own credential is the only way to reach it. It still appears, because the
   * catalog knows how to talk to it and the user is the one paying.
   */
  userOnly?: boolean;
}

/** Search engines that take an API key. DuckDuckGo is keyless and so not one. */
const SEARCH_PROVIDERS = ["ceramic", "hackclub", "llmsolutions", "exa"];

function inferenceConnectors(): Connector[] {
  const cfg = getConfig();
  const out: Connector[] = [];
  const enabled = new Set<string>();

  for (const p of cfg.providers) {
    enabled.add(p.id);
    out.push({
      service: "inference",
      id: p.id,
      byok: p.byok !== false,
      oauth: p.oauth && flowFor(p.oauth.flow) ? p.oauth : undefined,
      endpoint: resolveRef(p.apiEndpoint),
      type: p.type,
    });
  }

  // Everything catwalk knows about, for the user who brings a key to a provider
  // this deployment never enabled. The catalog already carries the endpoint,
  // the adapter type and the model list, so there is nothing for an operator to
  // configure — the credential is the only missing part, and it isn't theirs.
  const catalog = getCatalog();
  if (catalog) {
    for (const p of catalog.listProviders()) {
      if (enabled.has(p.id)) continue;
      out.push({
        service: "inference",
        id: p.id,
        byok: true,
        // Catwalk records endpoints as "$VAR" for providers whose address is
        // deployment-specific; unresolved, that string would be sent to fetch
        // verbatim. Empty is the right answer, since the SDK adapter for a
        // known provider already has its default.
        endpoint: resolveRef(p.apiEndpoint),
        type: p.type,
        userOnly: true,
      });
    }
  }
  return out;
}

function searchConnectors(): Connector[] {
  // Search has no per-provider config block to read a flag off, so every
  // key-taking engine is offered. A user who brings an Exa key gets Exa,
  // whether or not this deployment pays for one.
  const configured = new Set<string>();
  const cfg = getConfig().search;
  if (cfg.provider && cfg.provider !== "default" && cfg.provider !== "none") {
    configured.add(cfg.provider);
  }
  for (const b of cfg.backends ?? []) configured.add(b.provider);

  return SEARCH_PROVIDERS.map((id) => ({
    service: "search" as const,
    id,
    byok: true,
    userOnly: !configured.has(id),
  }));
}

/** Every connector, or an empty list when credentials cannot be stored at all. */
export function listConnectors(): Connector[] {
  if (!encryptionConfigured()) return [];
  return [...inferenceConnectors(), ...searchConnectors()];
}

export function findConnector(service: Service, id: string): Connector | undefined {
  return listConnectors().find((c) => c.service === service && c.id === id);
}

export function isService(value: string): value is Service {
  return (SERVICES as string[]).includes(value);
}
