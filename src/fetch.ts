import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { FETCH_MAX_REDIRECTS } from "./config";
import { type Config, getConfig } from "./settings";

/**
 * The `fetch_url` tool's backing: fetch a web page and return its main content
 * as clean markdown (boilerplate stripped). Behind a swappable provider so the
 * tool isn't coupled to one extraction strategy — a future backend (a headless
 * renderer for JS-heavy pages, a reader API) implements `FetchProvider` and the
 * tool is unchanged.
 *
 * Unlike a dev-CLI fetch (which can gate each call on a human approval), kloe
 * runs the loop autonomously, so the safety mechanism is an SSRF guard: the
 * model must not be able to make the server reach into the private network. We
 * check the RESOLVED ip against private/reserved ranges (a hostname check alone
 * is bypassable), re-check every redirect hop, and allow only http(s). Full
 * DNS-rebinding immunity needs ip-pinning at connect time (which `fetch` can't
 * express); this is the strong baseline, plus an `allowPrivate` escape hatch for
 * a homelab that deliberately wants to read its own services.
 */

/**
 * How a page's text was obtained. The model is told, because it changes what
 * the text is worth: an archived copy may be stale, a structured-data rescue is
 * a fragment rather than the article, and a rendered page is what a browser saw
 * rather than what the server sent us.
 */
export type FetchVia = "direct" | "amp" | "structured" | "rendered" | "archive";

/** One fetched page, normalized for the model. */
export interface FetchResult {
  /** Which route produced `content`; absent means the ordinary one. */
  via?: FetchVia;
  /** What was in the way, when something was. */
  note?: string;
  /**
   * The URL to SHOW a reader — the page this content belongs to.
   *
   * Not always the URL we fetched. A GitHub repo is read as a raw README off
   * raw.githubusercontent.com because that is where the text is, but a citation
   * pointing there sends the reader to a plain-text file on a hostname they
   * have no reason to trust, instead of the repository they were told about.
   * Rewrites are a fetching strategy, not a fact about where a page lives.
   *
   * Redirects are different and still followed here: if a link genuinely moved,
   * where it moved to IS the page.
   */
  url: string;
  /** What was actually fetched, when a rewrite made that a different URL. */
  fetchedUrl?: string;
  title: string;
  /** Extracted/negotiated markdown, or raw text (JSON, plain text, generic XML). */
  content: string;
  /** How to render `content`: prose markdown vs verbatim preformatted text. */
  format: "markdown" | "text";
  /** True when `content` was cut to the char cap. */
  truncated: boolean;
  /** The page's SVG favicon (absolute). Adaptive SVGs self-fix dark mode; either
   *  way it beats a flat service .ico. Preferred as the default mark. */
  faviconSvg?: string;
  /** An explicit dark-mode favicon variant (absolute) — a prefers-color-scheme
   *  media link or GitHub's data-base-href convention. Used as a dark <picture>
   *  source. Both favicon fields are candidates the client preloads. */
  faviconDark?: string;
}

export interface FetchProvider {
  fetch(url: string): Promise<FetchResult>;
}

type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

interface LocalFetchOptions {
  maxBytes: number;
  maxChars: number;
  timeoutMs: number;
  allowPrivate: boolean;
  userAgent: string;
  fetchImpl?: typeof fetch;
  lookupImpl?: Lookup;
  /** Headless browser for JS-only pages and challenge walls. Absent → no rendering. */
  renderer?: Renderer;
  /** Try the Wayback Machine when a page can't be read live. */
  archive?: boolean;
}

/** IPv4 dotted-quad → true if it's in a private/reserved/non-global range. */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → treat as unsafe
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 127) return true; // "this network", loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && p[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** IP (v4 or v6, incl. IPv4-mapped) → true if not a safe public address. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true; // loopback, unspecified
    // IPv4-mapped/compat (::ffff:1.2.3.4) — judge by the embedded v4.
    const m = v6.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
    if (m) return isPrivateIPv4(m[1]!);
    const head = v6.split(":")[0] ?? "";
    const hi = parseInt(head || "0", 16);
    if (
      v6.startsWith("fe8") ||
      v6.startsWith("fe9") ||
      v6.startsWith("fea") ||
      v6.startsWith("feb")
    )
      return true; // link-local fe80::/10
    if ((hi & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
    if (v6.startsWith("ff")) return true; // multicast
    return false;
  }
  return true; // not a valid IP literal → unsafe
}

/**
 * Rewrites known URLs to a cleaner source before fetching. GitHub blob pages are
 * heavy HTML that Readability mangles; the raw host serves the file itself. Kept
 * small and host-specific — a transparent "get better content" step.
 */
export function rewriteForFetch(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const host = u.hostname.replace(/^www\./, "");
  if (host === "github.com") {
    const rawBase = "https://raw.githubusercontent.com";
    const p = u.pathname.replace(/\/+$/, "");
    let m: RegExpMatchArray | null;
    // A file: /owner/repo/blob/<ref>/<path> → the raw file.
    if ((m = p.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/)))
      return `${rawBase}/${m[1]}/${m[2]}/${m[3]}`;
    // A directory or branch: /owner/repo/tree/<ref>(/<path>) → that dir's README.
    if ((m = p.match(/^\/([^/]+)\/([^/]+)\/tree\/(.+)$/)))
      return `${rawBase}/${m[1]}/${m[2]}/${m[3]}/README.md`;
    // The repo root: /owner/repo → the default-branch README (HEAD resolves it).
    if ((m = p.match(/^\/([^/]+)\/([^/]+)$/))) return `${rawBase}/${m[1]}/${m[2]}/HEAD/README.md`;
  }
  return raw;
}

// Known dark-appropriate favicons for hosts we can't read a <head> from — either
// because we rewrite the URL to raw content (GitHub repos → raw README, so there's
// no HTML page) or the host reliably serves these. Keyed on the ORIGINAL host.
const KNOWN_FAVICONS: Record<string, { svg?: string; dark?: string }> = {
  "github.com": {
    svg: "https://github.githubassets.com/favicons/favicon.svg",
    dark: "https://github.githubassets.com/favicons/favicon-dark.svg",
  },
};
function knownFavicons(rawUrl: string): { svg?: string; dark?: string } {
  try {
    return KNOWN_FAVICONS[new URL(rawUrl).hostname.replace(/^www\./, "")] ?? {};
  } catch {
    return {};
  }
}

/**
 * Validates a URL for fetching: http(s) only, host not `localhost`, and every
 * resolved address public (unless `allowPrivate`). Returns the parsed URL or
 * throws with a caller-safe message.
 */
export async function assertAllowedUrl(
  raw: string,
  allowPrivate: boolean,
  lookup: Lookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme "${url.protocol}" (only http/https)`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (allowPrivate) return url;
  if (/^(localhost|.*\.localhost)$/i.test(host)) throw new Error("refusing to fetch localhost");

  // If the host is a literal IP, check it directly; otherwise resolve and check
  // every address it points at (a public name can still map to a private ip).
  const literals = isIP(host) ? [host] : (await lookup(host)).map((r) => r.address);
  if (literals.length === 0) throw new Error(`could not resolve host: ${host}`);
  for (const ip of literals) {
    if (isPrivateIp(ip))
      throw new Error(`refusing to fetch a private/reserved address (${host} → ${ip})`);
  }
  return url;
}

/**
 * Heuristic: does this decoded body look like text (vs binary)? A null byte or a
 * high proportion of control/replacement chars means binary. Sampled, so it's
 * cheap even on a large file. Lets code/config files served with an odd or
 * generic content-type (application/octet-stream, application/javascript, …) pass
 * through as raw text instead of being dropped as "binary".
 */
function isProbablyText(s: string): boolean {
  if (s.length === 0) return false;
  const n = Math.min(s.length, 4000);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return false; // NUL → binary
    if (c === 0xfffd)
      bad++; // UTF-8 replacement char (invalid bytes)
    else if (c < 9 || (c > 13 && c < 32)) bad++; // control chars (allow \t \n \v \f \r)
  }
  return bad / n < 0.1;
}

/** Reads a response body as text, capped at `maxBytes`; marks if it was cut. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; capped: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", capped: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total >= maxBytes) {
        capped = true;
        await reader.cancel();
        break;
      }
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return { text: new TextDecoder("utf-8").decode(buf.subarray(0, maxBytes)), capped };
}

// ---- feeds (RSS / Atom / RDF) ------------------------------------------
// Feeds are XML, not documents — running them through Readability produces a
// run-together mess (CDATA leaks, no structure). Detect them and render a clean
// item list (linked title · date · snippet) the model can actually use.

const FEED_MAX_ITEMS = 40;

/** True if the content looks like an RSS/Atom/RDF feed (by type or root tag). */
function looksLikeFeed(contentType: string, text: string): boolean {
  if (/(rss|atom)\+xml/.test(contentType)) return true;
  return /<(rss\b|feed\b|rdf:rdf)/i.test(text.slice(0, 1000));
}

function asArray<T>(x: T | T[] | undefined | null): T[] {
  return Array.isArray(x) ? x : x == null ? [] : [x];
}
/** Text of an XML node (fast-xml-parser stores mixed content under "#text"). */
function xmlText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const t = (v as Record<string, unknown>)["#text"];
    return typeof t === "string" ? t : "";
  }
  return String(v);
}
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

interface FeedItem {
  title: string;
  link: string;
  date: string;
  summary: string;
}
function rssItem(it: Record<string, unknown>): FeedItem {
  return {
    title: xmlText(it.title),
    link: xmlText(it.link),
    date: xmlText(it.pubDate) || xmlText(it["dc:date"]),
    summary: stripTags(xmlText(it.description) || xmlText(it["content:encoded"])),
  };
}
function atomEntry(e: Record<string, unknown>): FeedItem {
  let link = "";
  const l = e.link as unknown;
  if (Array.isArray(l)) {
    const alt =
      (l as Array<Record<string, unknown>>).find((x) => x["@_rel"] === "alternate") ?? l[0];
    link = String(alt?.["@_href"] ?? "");
  } else if (l && typeof l === "object") {
    link = String((l as Record<string, unknown>)["@_href"] ?? "");
  } else {
    link = xmlText(l);
  }
  return {
    title: xmlText(e.title),
    link,
    date: xmlText(e.updated) || xmlText(e.published),
    summary: stripTags(xmlText(e.summary) || xmlText(e.content)),
  };
}

/** Parses an RSS/Atom/RDF feed into a markdown item list, or null if not a feed. */
function feedToMarkdown(xml: string): { title: string; markdown: string } | null {
  let doc: Record<string, unknown>;
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(
      xml,
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
  let title = "";
  let items: FeedItem[] = [];
  const rss = doc.rss as { channel?: Record<string, unknown> } | undefined;
  const feed = doc.feed as Record<string, unknown> | undefined;
  const rdf = (doc["rdf:RDF"] ?? doc.RDF) as
    | { channel?: Record<string, unknown>; item?: unknown }
    | undefined;
  if (rss?.channel) {
    title = xmlText(rss.channel.title);
    items = asArray(rss.channel.item as Record<string, unknown>[]).map(rssItem);
  } else if (feed) {
    title = xmlText(feed.title);
    items = asArray(feed.entry as Record<string, unknown>[]).map(atomEntry);
  } else if (rdf) {
    title = xmlText(rdf.channel?.title);
    items = asArray(rdf.item as Record<string, unknown>[]).map(rssItem);
  } else {
    return null;
  }

  const lines = items.slice(0, FEED_MAX_ITEMS).map((it) => {
    const head = it.link ? `[${it.title || it.link}](${it.link})` : it.title || "(untitled)";
    const meta = it.date ? ` — ${it.date}` : "";
    const snip = it.summary ? `\n  ${it.summary.slice(0, 240)}` : "";
    return `- ${head}${meta}${snip}`;
  });
  const more =
    items.length > FEED_MAX_ITEMS ? `\n\n…and ${items.length - FEED_MAX_ITEMS} more items.` : "";
  const heading = title || "Feed";
  return { title: heading, markdown: `# ${heading}\n\n${lines.join("\n")}${more}` };
}

/** HTML → main-content markdown, with a whole-body fallback if extraction fails. */
// The favicons a page declares that beat a flat .ico from a favicon service on a
// dark theme, resolved absolute. No service does theme-aware icons (they hand you
// one flat image), and there's no consumer-side library for this — so we read the
// page's own tags. Two things the client can use:
//   svg  — the page's SVG favicon. An *adaptive* SVG (prefers-color-scheme inside)
//          self-fixes dark mode when shown via <img>; a plain one is at least the
//          real logo. Preferred as the default mark when present.
//   dark — an explicit dark variant: a `prefers-color-scheme: dark` media link
//          (rare but clean), or GitHub's `js-site-favicon` convention where the
//          dark file is "<data-base-href>-dark.svg".
// Both are *candidates* — the client preloads and falls back if one 404s.
function pageFavicons(
  doc: ReturnType<typeof parseHTML>["document"],
  baseUrl: string,
): { svg?: string; dark?: string } {
  const abs = (href: string): string | undefined => {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return undefined;
    }
  };
  let svg: string | undefined;
  let dark: string | undefined;
  const links = doc.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]');
  for (const l of Array.from(links) as Array<{ getAttribute(name: string): string | null }>) {
    const type = (l.getAttribute("type") || "").toLowerCase();
    const media = (l.getAttribute("media") || "").toLowerCase();
    const href = l.getAttribute("href");
    if (href && media.includes("prefers-color-scheme") && media.includes("dark"))
      dark = dark ?? abs(href);
    else if (href && (type.includes("svg") || /\.svg(\?|#|$)/i.test(href))) svg = svg ?? abs(href);
    const base = l.getAttribute("data-base-href");
    if (base) dark = dark ?? abs(base + "-dark.svg");
  }
  return { svg, dark };
}

function htmlToMarkdown(
  html: string,
  baseUrl: string,
): { title: string; markdown: string; faviconSvg?: string; faviconDark?: string } {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // Drop boilerplate/noise in BOTH paths — Readability already isolates the
  // article, but the whole-body fallback needs these stripped too.
  td.remove([
    "script",
    "style",
    "noscript",
    "iframe",
    "svg",
    "form",
    "nav",
    "header",
    "footer",
    "aside",
  ]);
  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent?.trim() || baseUrl;
  // Read the favicons NOW — Readability.parse() mutates the document (it strips it
  // down to the article, removing <head> links), so doing this afterwards finds
  // nothing on any page where Readability succeeds (i.e. most content pages).
  const favs = pageFavicons(document, baseUrl);
  let article: {
    title?: string | null;
    content?: string | null;
    textContent?: string | null;
  } | null = null;
  try {
    article = new Readability(
      document as unknown as ConstructorParameters<typeof Readability>[0],
    ).parse();
  } catch {
    article = null;
  }
  // Readability found a real article → convert its isolated content. Otherwise
  // fall back to the whole body (turndown still drops the removed noise tags).
  const source =
    article && article.content && (article.textContent ?? "").trim().length > 40
      ? article.content
      : document.body?.innerHTML || html;
  const markdown = td
    .turndown(source)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title: (article?.title || title).trim(),
    markdown,
    faviconSvg: favs.svg,
    faviconDark: favs.dark,
  };
}

// ---- anti-bot walls ---------------------------------------------------------
/**
 * Whether a response is a bot wall rather than the page.
 *
 * Worth detecting precisely, because the three ways a fetch comes back empty
 * want three different next moves: a challenge can be rendered through a real
 * browser, a hard denial cannot and the model should go elsewhere, and an empty
 * extraction is a rendering problem. Answering all of them with "no readable
 * content" (which is what this did) sends the model back to the same wall.
 *
 * The markers are vendor-specific strings, so false positives are rare.
 * Cloudflare's `cf-mitigated: challenge` is documented and definitive; the rest
 * are the tells each vendor's block page carries.
 */
export interface Blockage {
  vendor: string;
  /** `challenge` may yield to a browser; `denied` is a refusal to serve us. */
  kind: "challenge" | "denied";
}

export function detectBlockage(status: number, headers: Headers, body: string): Blockage | null {
  const h = (n: string) => (headers.get(n) || "").toLowerCase();
  const head = body.slice(0, 65_536);
  const has = (re: RegExp) => re.test(head);

  // Cloudflare states it outright on every challenge type.
  if (h("cf-mitigated").includes("challenge")) return { vendor: "cloudflare", kind: "challenge" };
  if (has(/cdn-cgi\/challenge-platform|_cf_chl_opt|cf_chl_|challenges\.cloudflare\.com/i)) {
    return { vendor: "cloudflare", kind: "challenge" };
  }
  if (has(/<title>\s*just a moment/i)) return { vendor: "cloudflare", kind: "challenge" };
  if (h("server").includes("cloudflare") && (status === 403 || status === 503)) {
    return {
      vendor: "cloudflare",
      kind: has(/attention required|you have been blocked|error 1020/i) ? "denied" : "challenge",
    };
  }
  if (h("x-datadome") || has(/datadome/i)) return { vendor: "datadome", kind: "challenge" };
  if (has(/_incapsula_resource|incapsula incident id/i))
    return { vendor: "imperva", kind: "denied" };
  if (has(/perimeterx|_pxhd|px-captcha/i)) return { vendor: "perimeterx", kind: "challenge" };
  if (has(/access denied[\s\S]{0,200}reference #\d/i)) return { vendor: "akamai", kind: "denied" };
  if (status === 403 && has(/enable javascript and cookies to continue/i))
    return { vendor: "unknown", kind: "challenge" };
  return null;
}

// ---- rescuing a page the extractor came back empty on -----------------------
/**
 * Content already in the HTML that Readability didn't count as an article.
 *
 * A JS-shell page usually isn't as empty as it looks: the metadata a page ships
 * for search engines and social cards is server-rendered even when the article
 * isn't. This is explicitly a RESCUE, not an extraction — `articleBody` is often
 * a summary rather than the full text, and the caller labels what it hands back
 * so nobody mistakes a description for the piece.
 */
export function structuredRescue(
  html: string,
  baseUrl: string,
): { title: string; markdown: string } | null {
  const { document } = parseHTML(html);
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
  const parts: string[] = [];
  let title = document.querySelector("title")?.textContent?.trim() || "";

  // JSON-LD first: when a site does ship articleBody, it is the real text.
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data: unknown;
    try {
      data = JSON.parse(node.textContent || "");
    } catch {
      continue;
    }
    for (const item of flattenLd(data)) {
      const body = typeof item.articleBody === "string" ? item.articleBody.trim() : "";
      const head = typeof item.headline === "string" ? item.headline.trim() : "";
      const desc = typeof item.description === "string" ? item.description.trim() : "";
      if (head && !title) title = head;
      if (body) parts.push(body);
      else if (desc) parts.push(desc);
    }
  }
  if (!parts.length) {
    const og = meta('meta[property="og:description"]') || meta('meta[name="description"]');
    if (og) parts.push(og);
    const ogTitle = meta('meta[property="og:title"]');
    if (ogTitle && !title) title = ogTitle;
  }
  // A <noscript> block is written for exactly this situation and often carries
  // the whole article on sites that degrade properly.
  const noscript = document.querySelector("noscript")?.textContent?.trim() || "";
  if (noscript.length > 200) parts.push(noscript.replace(/\s+/g, " "));

  const markdown = parts.join("\n\n").trim();
  if (markdown.length < 80) return null; // a headline and nothing else isn't a rescue
  return { title: title || baseUrl, markdown };
}

/** JSON-LD arrives as an object, an array, or an @graph — flatten all three. */
function flattenLd(data: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      out.push(o);
      if (o["@graph"]) walk(o["@graph"]);
    }
  };
  walk(data);
  return out;
}

/** A page's AMP twin, when it declares one. AMP is static by construction. */
export function ampLink(html: string, baseUrl: string): string | null {
  const { document } = parseHTML(html);
  const href = document.querySelector('link[rel="amphtml"]')?.getAttribute("href");
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl).href;
    return url === baseUrl ? null : url;
  } catch {
    return null;
  }
}

// ---- headless rendering -----------------------------------------------------
/** A page as a real browser saw it, after scripts and any challenge. */
export interface Renderer {
  render(url: string, signal?: AbortSignal): Promise<{ url: string; html: string; status: number }>;
}

/**
 * FlareSolverr (github.com/FlareSolverr/FlareSolverr): POST /v1 with
 * `cmd: request.get`, get back the post-JS HTML.
 *
 * Calls are serialized. FlareSolverr drives one Chrome and a challenge takes
 * five to fifteen seconds; six research workers hitting it at once would each
 * wait for all the others, and the queue would outlive their budgets. One at a
 * time is not a limitation we are imposing — it is the one it has.
 */
export class FlareSolverrRenderer implements Renderer {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: { endpoint: string; timeoutMs: number; fetchImpl?: typeof fetch }) {
    this.endpoint = opts.endpoint;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  render(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; html: string; status: number }> {
    const run = this.queue.then(
      () => this.one(url, signal),
      () => this.one(url, signal), // a previous failure must not poison the queue
    );
    this.queue = run.catch(() => {});
    return run;
  }

  private async one(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; html: string; status: number }> {
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url, maxTimeout: this.timeoutMs }),
      signal: signal ?? AbortSignal.timeout(this.timeoutMs + 5_000),
    });
    if (!res.ok) throw new Error(`renderer failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as {
      status?: string;
      message?: string;
      solution?: { url?: string; status?: number; response?: string };
    };
    if (data.status !== "ok" || !data.solution?.response) {
      throw new Error(`renderer could not load the page: ${data.message || "no solution"}`);
    }
    return {
      url: data.solution.url || url,
      html: data.solution.response,
      status: data.solution.status ?? 200,
    };
  }
}

/** The most recent Wayback capture of a URL, if there is one. */
export async function archivedUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<string | null> {
  try {
    const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const res = await fetchImpl(api, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      archived_snapshots?: { closest?: { available?: boolean; url?: string } };
    };
    const closest = data.archived_snapshots?.closest;
    return closest?.available && closest.url ? closest.url.replace(/^http:/, "https:") : null;
  } catch {
    return null;
  }
}

export class LocalFetchProvider implements FetchProvider {
  private readonly opts: LocalFetchOptions;
  constructor(opts: LocalFetchOptions) {
    this.opts = opts;
  }

  /**
   * Fetch a page, escalating only as far as it has to.
   *
   * The ladder, cheapest first: the plain request; the page's own AMP twin;
   * whatever content is in the HTML for search engines; a real browser; the
   * Wayback Machine. Each rung exists because the one before it comes back
   * empty on a real class of page, and every rung is skipped when the one
   * before it worked — which is nearly always.
   *
   * What it will not do is pretend to be somebody else. Rendering a public page
   * in a browser is a different thing from forging a Googlebot user-agent to
   * get past a paywall, and only the first is here.
   */
  async fetch(rawUrl: string): Promise<FetchResult> {
    // A rewrite is ours, so a citation points at what the user asked for; a
    // redirect is the web's, so it points where the web went.
    const rewritten = rewriteForFetch(rawUrl);
    const display = rewritten === rawUrl ? undefined : rawUrl;
    const direct = await this.direct(rawUrl);
    if (direct.ok) {
      const out = this.toResult(
        direct.text,
        direct.contentType,
        direct.url,
        rawUrl,
        direct.capped,
        display,
      );
      if (!isThin(out, direct.text, direct.contentType)) return out;
      // Read fine, said nothing: a JS shell, or an article Readability didn't
      // recognize. Try the page's own static twin, then its metadata.
      const rescued = await this.rescue(direct.text, direct.url, rawUrl, display);
      if (rescued) return rescued;
    }
    const blocked = direct.ok ? null : direct.blockage;
    // A challenge yields to a browser; a hard denial does not, but a JS shell
    // does too — so render whenever we have one and the cheap path came up empty.
    if (this.opts.renderer && (!blocked || blocked.kind === "challenge" || direct.ok)) {
      try {
        const rendered = await this.renderPage(rawUrl);
        if (rendered) {
          rendered.note = blocked ? `${blocked.vendor} ${blocked.kind}; rendered` : undefined;
          return rendered;
        }
      } catch (e) {
        // A renderer that is down must not turn a readable page into an error.
        console.warn("[fetch] render failed:", (e as Error).message);
      }
    }
    if (this.opts.archive) {
      const archived = await this.fromArchive(rawUrl);
      if (archived) {
        archived.note = blocked
          ? `live page blocked (${blocked.vendor} ${blocked.kind}); served from the Wayback Machine`
          : "live page had no readable content; served from the Wayback Machine";
        return archived;
      }
    }
    if (direct.ok) {
      // Nothing worked, but the server did answer: hand back the empty result
      // with an explanation rather than an error.
      const out = this.toResult(direct.text, direct.contentType, direct.url, rawUrl, direct.capped);
      out.content = this.opts.renderer
        ? "No readable content could be extracted: the page renders its content with JavaScript and rendering it in a browser did not help either. Try a different source."
        : "No readable content could be extracted — the page appears to render its content with JavaScript, which this fetcher does not execute. Try a different source, or an archived copy.";
      out.format = "text";
      return out;
    }
    throw new Error(direct.error);
  }

  /** The plain request, redirects re-validated at every hop. */
  private async direct(rawUrl: string): Promise<DirectFetch> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const lookup =
      this.opts.lookupImpl ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true }));

    // Follow redirects manually so every hop is re-validated against the SSRF
    // policy (an allowed URL can 30x into the private network).
    let current = rewriteForFetch(rawUrl); // e.g. github blob → raw file
    let res: Response | null = null;
    for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
      const url = await assertAllowedUrl(current, this.opts.allowPrivate, lookup);
      res = await doFetch(url.href, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        // Prefer markdown via content negotiation — a server that can serve it
        // (many docs sites now do) saves us the lossy HTML→markdown conversion;
        // one that can't just ignores Accept and returns HTML as before.
        headers: {
          "User-Agent": this.opts.userAgent,
          Accept:
            "text/markdown,text/x-markdown;q=0.9,text/html;q=0.8,application/xhtml+xml;q=0.8,text/plain;q=0.6,*/*;q=0.5",
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        current = new URL(loc, url.href).href; // resolve relative redirects
        if (hop === FETCH_MAX_REDIRECTS) throw new Error("too many redirects");
        continue;
      }
      break;
    }
    if (!res) return { ok: false, url: current, error: "fetch failed" };
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok) {
      // Read the body anyway: a block page explains itself in it, and so do
      // most ordinary errors. Surface a snippet so the model gets more than a
      // bare status code.
      let body = "";
      try {
        body = (await readCapped(res, 65_536)).text;
      } catch {
        /* ignore a body we can't read */
      }
      const blockage = detectBlockage(res.status, res.headers, body);
      const t = isProbablyText(body)
        ? body
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : "";
      const detail = blockage
        ? ` — ${blockage.vendor} ${blockage.kind === "challenge" ? "bot challenge" : "blocked this request"}`
        : t
          ? " — " + t.slice(0, 200)
          : "";
      return {
        ok: false,
        url: current,
        blockage,
        error: `fetch failed: ${res.status} ${res.statusText}${detail}`,
      };
    }
    const { text, capped } = await readCapped(res, this.opts.maxBytes);
    // A 200 can still be a wall: Cloudflare's JS challenge is served as one.
    const blockage = detectBlockage(res.status, res.headers, text);
    return { ok: true, url: current, contentType, text, capped, blockage };
  }

  /** Turn a fetched body into a result, whatever route produced it. */
  private toResult(
    text: string,
    contentType: string,
    current: string,
    rawUrl: string,
    capped: boolean,
    display?: string,
  ): FetchResult {
    let title = current;
    let content: string;
    let format: "markdown" | "text" = "text";
    let faviconSvg: string | undefined;
    let faviconDark: string | undefined;
    if (contentType.includes("markdown")) {
      // The server negotiated markdown directly — use it verbatim (no lossy
      // HTML round-trip), and lift the first H1 as the title.
      content = text.trim();
      title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || current;
      format = "markdown";
    } else if (looksLikeFeed(contentType, text)) {
      const feed = feedToMarkdown(text);
      if (feed) {
        title = feed.title;
        content = feed.markdown;
        format = "markdown";
      } else content = text.trim(); // malformed feed → hand back the raw XML (text)
    } else if (contentType.includes("xml")) {
      content = text.trim(); // generic XML: raw, don't force it through the HTML pipeline
    } else if (
      contentType.includes("html") ||
      /^\s*<(!doctype|html|head|body|div|p|article|main|section)\b/i.test(text)
    ) {
      const out = htmlToMarkdown(text, current);
      title = out.title;
      content = out.markdown;
      format = "markdown";
      faviconSvg = out.faviconSvg;
      faviconDark = out.faviconDark;
    } else if (
      contentType.includes("text/") ||
      contentType.includes("json") ||
      contentType === "" ||
      isProbablyText(text)
    ) {
      // Text by content-type OR by sniffing (code/config files with a generic or
      // odd type): pass it through verbatim. Size is already bounded by the byte
      // and char caps. A markdown file served as text (e.g. a raw README) is
      // prose-rendered with its H1 as the title.
      content = text.trim();
      if (/\.(md|markdown)$/i.test(new URL(current).pathname)) {
        format = "markdown";
        title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || current;
      }
    } else {
      content = `[${contentType || "binary"} content — not rendered as text]`;
    }

    let truncated = capped;
    if (content.length > this.opts.maxChars) {
      content =
        content.slice(0, this.opts.maxChars) + `\n\n…[truncated to ${this.opts.maxChars} chars]`;
      truncated = true;
    }
    // No page favicons (a raw-content rewrite left no HTML, e.g. a GitHub repo)?
    // Fall back to the original host's known ones. `rawUrl` is what the user asked
    // for, before rewriteForFetch pointed us at raw.githubusercontent.com.
    if (!faviconSvg && !faviconDark) {
      const known = knownFavicons(rawUrl);
      faviconSvg = known.svg;
      faviconDark = known.dark;
    }
    // `display` is the page a citation should point at; `current` is where the
    // bytes came from. They differ only when we rewrote the URL ourselves.
    const shown = display ?? current;
    return {
      url: shown,
      ...(shown === current ? {} : { fetchedUrl: current }),
      title,
      content,
      format,
      truncated,
      faviconSvg,
      faviconDark,
    };
  }

  /** The page's own static twin, then whatever it ships for search engines. */
  private async rescue(
    html: string,
    current: string,
    rawUrl: string,
    display?: string,
  ): Promise<FetchResult | null> {
    const amp = ampLink(html, current);
    if (amp) {
      const got = await this.direct(amp).catch(() => null);
      if (got?.ok) {
        // An AMP twin is our escalation, not the page's address: cite the
        // page the reader asked about.
        const out = this.toResult(
          got.text,
          got.contentType,
          got.url,
          rawUrl,
          got.capped,
          display ?? rawUrl,
        );
        if (!isThin(out, got.text, got.contentType)) {
          out.via = "amp";
          out.fetchedUrl = got.url;
          return out;
        }
      }
    }
    const rescued = structuredRescue(html, current);
    if (!rescued) return null;
    return {
      url: display ?? current,
      title: rescued.title,
      // Labelled, because it usually isn't the article: JSON-LD `articleBody`
      // is often a summary, and a description is definitely one.
      content: `[The page's own text could not be extracted; this is the description and metadata it publishes.]\n\n${rescued.markdown}`,
      format: "markdown",
      truncated: false,
      via: "structured",
      ...knownFaviconFields(rawUrl),
    };
  }

  /** The page as a browser sees it — scripts run, challenges answered. */
  private async renderPage(rawUrl: string): Promise<FetchResult | null> {
    if (!this.opts.renderer) return null;
    // The renderer runs on the operator's network and does its own DNS and
    // redirects, so nothing we check afterwards can constrain it. The SSRF
    // policy has to be applied to the URL BEFORE it is handed over.
    const lookup =
      this.opts.lookupImpl ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true }));
    const url = await assertAllowedUrl(rewriteForFetch(rawUrl), this.opts.allowPrivate, lookup);
    const out = await this.opts.renderer.render(url.href);
    const rewritten = rewriteForFetch(rawUrl);
    const result = this.toResult(
      out.html,
      "text/html",
      out.url,
      rawUrl,
      false,
      rewritten === rawUrl ? undefined : rawUrl,
    );
    // A browser that renders the page and still yields nothing has told us the
    // page has nothing, and the ladder should move on rather than return it.
    if (isThin(result, out.html, "text/html")) return null;
    result.via = "rendered";
    return result;
  }

  /** The most recent Wayback capture, read through the ordinary path. */
  private async fromArchive(rawUrl: string): Promise<FetchResult | null> {
    const snapshot = await archivedUrl(rawUrl, this.opts.fetchImpl ?? fetch);
    if (!snapshot) return null;
    const got = await this.direct(snapshot).catch(() => null);
    if (!got?.ok) return null;
    const out = this.toResult(got.text, got.contentType, got.url, rawUrl, got.capped);
    if (isThin(out, got.text, got.contentType)) return null;
    out.via = "archive";
    return out;
  }
}

/** What `direct` learned about one request. */
type DirectFetch =
  | {
      ok: true;
      url: string;
      contentType: string;
      text: string;
      capped: boolean;
      blockage: Blockage | null;
    }
  | { ok: false; url: string; error: string; blockage?: Blockage | null };

/**
 * Whether an extraction is worth returning, or worth escalating past.
 *
 * This is the trigger for every rung of the ladder, and it asks about the
 * OUTCOME rather than the page. Testing whether HTML *looks* like a single-page
 * app misfires constantly — Next and Nuxt server-render their content and look
 * identical to a shell that doesn't.
 *
 * Two conditions, and the second is what keeps it honest: a big document that
 * yielded almost nothing is a shell, while a small document that yielded almost
 * nothing is simply a short page. Escalating on length alone would send every
 * one-paragraph page through a browser.
 */
const THIN_CHARS = 200;
const SHELL_BYTES = 4_000;
function isThin(r: FetchResult, source = "", contentType = ""): boolean {
  const got = r.content.trim().length;
  if (got === 0) return true;
  const htmlish = contentType.includes("html") || /^\s*<(!doctype|html)\b/i.test(source);
  return htmlish && got < THIN_CHARS && source.length > SHELL_BYTES;
}

/** Host-level favicons for a result assembled without page HTML. */
function knownFaviconFields(rawUrl: string): { faviconSvg?: string; faviconDark?: string } {
  const known = knownFavicons(rawUrl);
  return { faviconSvg: known.svg, faviconDark: known.dark };
}

/** The configured headless renderer, or null when none is set up. */
export function createRenderer(cfg: Config["fetch"]["renderer"]): Renderer | null {
  switch (cfg.provider) {
    case "flaresolverr":
      return cfg.endpoint
        ? new FlareSolverrRenderer({ endpoint: cfg.endpoint, timeoutMs: cfg.timeoutMs })
        : null;
    default:
      return null; // "none"
  }
}

/** Builds the configured fetch provider, or null when disabled. */
export function createFetchProvider(
  cfg: Config["fetch"] = getConfig().fetch,
): FetchProvider | null {
  if (!cfg.enabled) return null;
  return new LocalFetchProvider({
    maxBytes: cfg.maxBytes,
    maxChars: cfg.maxChars,
    timeoutMs: cfg.timeoutMs,
    allowPrivate: cfg.allowPrivate,
    userAgent: cfg.userAgent,
    renderer: createRenderer(cfg.renderer) ?? undefined,
    archive: cfg.archive,
  });
}
