import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { XMLParser } from "fast-xml-parser";
import { getConfig, type Config } from "./settings";
import { FETCH_MAX_REDIRECTS } from "./config";

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

/** One fetched page, normalized for the model. */
export interface FetchResult {
  /** The final URL after redirects. */
  url: string;
  title: string;
  /** Extracted/negotiated markdown, or raw text (JSON, plain text, generic XML). */
  content: string;
  /** How to render `content`: prose markdown vs verbatim preformatted text. */
  format: "markdown" | "text";
  /** True when `content` was cut to the char cap. */
  truncated: boolean;
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
    if (v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) return true; // link-local fe80::/10
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
  try { u = new URL(raw); } catch { return raw; }
  const host = u.hostname.replace(/^www\./, "");
  if (host === "github.com") {
    const rawBase = "https://raw.githubusercontent.com";
    const p = u.pathname.replace(/\/+$/, "");
    let m: RegExpMatchArray | null;
    // A file: /owner/repo/blob/<ref>/<path> → the raw file.
    if ((m = p.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/))) return `${rawBase}/${m[1]}/${m[2]}/${m[3]}`;
    // A directory or branch: /owner/repo/tree/<ref>(/<path>) → that dir's README.
    if ((m = p.match(/^\/([^/]+)\/([^/]+)\/tree\/(.+)$/))) return `${rawBase}/${m[1]}/${m[2]}/${m[3]}/README.md`;
    // The repo root: /owner/repo → the default-branch README (HEAD resolves it).
    if ((m = p.match(/^\/([^/]+)\/([^/]+)$/))) return `${rawBase}/${m[1]}/${m[2]}/HEAD/README.md`;
  }
  return raw;
}

/**
 * Validates a URL for fetching: http(s) only, host not `localhost`, and every
 * resolved address public (unless `allowPrivate`). Returns the parsed URL or
 * throws with a caller-safe message.
 */
export async function assertAllowedUrl(raw: string, allowPrivate: boolean, lookup: Lookup): Promise<URL> {
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
    if (isPrivateIp(ip)) throw new Error(`refusing to fetch a private/reserved address (${host} → ${ip})`);
  }
  return url;
}

/** Reads a response body as text, capped at `maxBytes`; marks if it was cut. */
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; capped: boolean }> {
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
      if (total >= maxBytes) { capped = true; await reader.cancel(); break; }
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
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
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

interface FeedItem { title: string; link: string; date: string; summary: string }
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
    const alt = (l as Array<Record<string, unknown>>).find((x) => x["@_rel"] === "alternate") ?? l[0];
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
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml) as Record<string, unknown>;
  } catch {
    return null;
  }
  let title = "";
  let items: FeedItem[] = [];
  const rss = doc.rss as { channel?: Record<string, unknown> } | undefined;
  const feed = doc.feed as Record<string, unknown> | undefined;
  const rdf = (doc["rdf:RDF"] ?? doc.RDF) as { channel?: Record<string, unknown>; item?: unknown } | undefined;
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
  const more = items.length > FEED_MAX_ITEMS ? `\n\n…and ${items.length - FEED_MAX_ITEMS} more items.` : "";
  const heading = title || "Feed";
  return { title: heading, markdown: `# ${heading}\n\n${lines.join("\n")}${more}` };
}

/** HTML → main-content markdown, with a whole-body fallback if extraction fails. */
function htmlToMarkdown(html: string, baseUrl: string): { title: string; markdown: string } {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  // Drop boilerplate/noise in BOTH paths — Readability already isolates the
  // article, but the whole-body fallback needs these stripped too.
  td.remove(["script", "style", "noscript", "iframe", "svg", "form", "nav", "header", "footer", "aside"]);
  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent?.trim() || baseUrl;
  let article: { title?: string | null; content?: string | null; textContent?: string | null } | null = null;
  try {
    article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse();
  } catch {
    article = null;
  }
  // Readability found a real article → convert its isolated content. Otherwise
  // fall back to the whole body (turndown still drops the removed noise tags).
  const source =
    article && article.content && (article.textContent ?? "").trim().length > 40
      ? article.content
      : document.body?.innerHTML || html;
  const markdown = td.turndown(source).replace(/\n{3,}/g, "\n\n").trim();
  return { title: (article?.title || title).trim(), markdown };
}

export class LocalFetchProvider implements FetchProvider {
  private readonly opts: LocalFetchOptions;
  constructor(opts: LocalFetchOptions) {
    this.opts = opts;
  }

  async fetch(rawUrl: string): Promise<FetchResult> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const lookup = this.opts.lookupImpl ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true }));

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
          Accept: "text/markdown,text/x-markdown;q=0.9,text/html;q=0.8,application/xhtml+xml;q=0.8,text/plain;q=0.6,*/*;q=0.5",
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
    if (!res) throw new Error("fetch failed");
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const { text, capped } = await readCapped(res, this.opts.maxBytes);

    let title = current;
    let content: string;
    let format: "markdown" | "text" = "text";
    if (contentType.includes("markdown")) {
      // The server negotiated markdown directly — use it verbatim (no lossy
      // HTML round-trip), and lift the first H1 as the title.
      content = text.trim();
      title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || current;
      format = "markdown";
    } else if (looksLikeFeed(contentType, text)) {
      const feed = feedToMarkdown(text);
      if (feed) { title = feed.title; content = feed.markdown; format = "markdown"; }
      else content = text.trim(); // malformed feed → hand back the raw XML (text)
    } else if (contentType.includes("xml")) {
      content = text.trim(); // generic XML: raw, don't force it through the HTML pipeline
    } else if (contentType.includes("html") || /^\s*<(!doctype|html|head|body|div|p|article|main|section)\b/i.test(text)) {
      const out = htmlToMarkdown(text, current);
      title = out.title;
      content = out.markdown;
      format = "markdown";
    } else if (contentType.includes("text/") || contentType.includes("json") || contentType === "") {
      content = text.trim(); // plain text / JSON: verbatim
      // …unless it's a markdown file served as text/plain (e.g. a raw README on
      // GitHub) — then prose-render it.
      if (/\.(md|markdown)$/i.test(new URL(current).pathname)) {
        format = "markdown";
        title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || current;
      }
    } else {
      content = `[${contentType || "binary"} content — not rendered as text]`;
    }

    let truncated = capped;
    if (content.length > this.opts.maxChars) {
      content = content.slice(0, this.opts.maxChars) + `\n\n…[truncated to ${this.opts.maxChars} chars]`;
      truncated = true;
    }
    return { url: current, title, content, format, truncated };
  }
}

/** Builds the configured fetch provider, or null when disabled. */
export function createFetchProvider(cfg: Config["fetch"] = getConfig().fetch): FetchProvider | null {
  if (!cfg.enabled) return null;
  return new LocalFetchProvider({
    maxBytes: cfg.maxBytes,
    maxChars: cfg.maxChars,
    timeoutMs: cfg.timeoutMs,
    allowPrivate: cfg.allowPrivate,
    userAgent: cfg.userAgent,
  });
}
