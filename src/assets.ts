/**
 * The client build, owned explicitly rather than left to Bun.serve's native HTML
 * routes. Owning it buys three things the native path can't give us: real
 * `Cache-Control: immutable` on the content-hashed chunks (so a navigation
 * re-fetches zero bytes instead of revalidating ~100KB), build-time compression
 * (br/gzip precomputed once, not per request — Bun.serve does none of its own),
 * and clean root-absolute asset paths (`/chunk-*.js`, via `publicPath`) that work
 * under the parameterized routes `/c/:id` and `/p/:id` where the native serving
 * emitted broken `/../../chunk-*` refs.
 *
 * `splitting: false` reproduces the existing per-page bundle graph exactly (one JS
 * per entry, one shared CSS) — no module-preload waterfall, no behavior change.
 * The enrichment bundle stays its own split build (see server.ts); it dynamic-
 * imports per-language grammars and must not ride these entries.
 */
import { brotliCompressSync, gzipSync, constants as zlib } from "node:zlib";

const CLIENT_DIR = new URL("./client/", import.meta.url).pathname;
// The whole app is one document now: the shell (index.html). Every section —
// conversations, projects, project-detail, settings — is served by the shell and
// mounted by the router from src/client/views/*.
const ENTRY_HTML = ["index.html"];

/** A built output ready to serve: raw bytes plus precomputed encodings and its ETag. */
export interface ServedAsset {
  raw: Uint8Array;
  br?: Uint8Array;
  gzip?: Uint8Array;
  type: string;
  etag: string;
}

export interface ClientBundle {
  /** Entry documents keyed by basename ("index.html", …) — stable across rebuilds. */
  html: Map<string, ServedAsset>;
  /** Content-hashed assets keyed by basename ("chunk-*.js", "favicon-*.ico", …). */
  assets: Map<string, ServedAsset>;
}

// Only text-ish types benefit from compression; png/ico are already compressed,
// so paying brotli on them would waste bytes and build time.
const COMPRESSIBLE = /javascript|css|html|svg|json|manifest|text/;

function toAsset(bytes: Uint8Array, type: string, hash: string, compress: boolean): ServedAsset {
  const asset: ServedAsset = { raw: bytes, type, etag: `"${hash}"` };
  if (compress && COMPRESSIBLE.test(type)) {
    // Build-time, so max quality — this runs once per deploy, never per request.
    asset.br = brotliCompressSync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } });
    asset.gzip = gzipSync(bytes, { level: 9 });
  }
  return asset;
}

/**
 * Build every client entry into an in-memory bundle. In dev we skip minify +
 * compression so the watch-triggered rebuild stays snappy; prod gets the full
 * treatment. Throws on a failed build so the server doesn't come up serving a
 * stale or empty client.
 */
export async function buildClient(dev: boolean): Promise<ClientBundle> {
  const build = await Bun.build({
    entrypoints: ENTRY_HTML.map((f) => CLIENT_DIR + f),
    target: "browser",
    minify: !dev,
    splitting: false,
    publicPath: "/",
  });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    throw new Error("client build failed");
  }
  const html = new Map<string, ServedAsset>();
  const assets = new Map<string, ServedAsset>();
  for (const out of build.outputs) {
    const name = out.path.replace(/^\.?\//, "");
    const bytes = new Uint8Array(await out.arrayBuffer());
    const hash = out.hash ?? Bun.hash(bytes).toString(16);
    const asset = toAsset(bytes, out.type || "application/octet-stream", hash, !dev);
    if (name.endsWith(".html")) html.set(name, asset);
    else assets.set(name, asset);
  }
  return { html, assets };
}

/**
 * Serve a built asset with the given cache policy, honoring the request's
 * Accept-Encoding (precomputed br/gzip) and answering a matching If-None-Match
 * with a 304 — so unchanged hashed assets cost one tiny conditional round-trip at
 * most, and immutable ones aren't even re-requested.
 */
export function serveAsset(req: Request, a: ServedAsset, cache: string): Response {
  if (req.headers.get("if-none-match") === a.etag) {
    return new Response(null, { status: 304, headers: { ETag: a.etag, "Cache-Control": cache } });
  }
  const accept = req.headers.get("accept-encoding") ?? "";
  let body: Uint8Array = a.raw;
  let encoding: string | undefined;
  if (a.br && /\bbr\b/.test(accept)) {
    body = a.br;
    encoding = "br";
  } else if (a.gzip && /\bgzip\b/.test(accept)) {
    body = a.gzip;
    encoding = "gzip";
  }
  const headers: Record<string, string> = {
    "Content-Type": a.type,
    "Cache-Control": cache,
    ETag: a.etag,
  };
  if (a.br || a.gzip) headers.Vary = "Accept-Encoding";
  if (encoding) headers["Content-Encoding"] = encoding;
  return new Response(body, { headers });
}

/** Content-hashed → cache forever. */
export const ASSET_CACHE = "public, max-age=31536000, immutable";
/** Stable-URL entry documents → revalidate (ETag yields a 304 when unchanged). */
export const HTML_CACHE = "no-cache";
