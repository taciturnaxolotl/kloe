import { test, expect } from "bun:test";
import { isPrivateIp, assertAllowedUrl, LocalFetchProvider, createFetchProvider, rewriteForFetch } from "../src/fetch";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = async () => [{ address: "192.168.1.10", family: 4 }];

const opts = (over: Record<string, unknown> = {}) =>
  ({ maxBytes: 1_000_000, maxChars: 50_000, timeoutMs: 5000, allowPrivate: false, userAgent: "test", lookupImpl: publicLookup, ...over }) as never;
const htmlRes = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html", ...(init.headers ?? {}) }, ...init });

test("isPrivateIp flags private/reserved addresses and allows public ones", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.5.4", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"])
    expect(isPrivateIp(ip)).toBe(true);
  for (const ip of ["93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    expect(isPrivateIp(ip)).toBe(false);
});

test("assertAllowedUrl rejects non-http, localhost, and private resolutions", async () => {
  await expect(assertAllowedUrl("ftp://x/", false, publicLookup)).rejects.toThrow(/scheme/);
  await expect(assertAllowedUrl("http://localhost/x", false, publicLookup)).rejects.toThrow(/localhost/);
  await expect(assertAllowedUrl("http://internal.corp/", false, privateLookup)).rejects.toThrow(/private|reserved/);
  await expect(assertAllowedUrl("http://169.254.169.254/latest", false, publicLookup)).rejects.toThrow(/private|reserved/);
  const u = await assertAllowedUrl("https://example.com/p", false, publicLookup);
  expect(u.href).toBe("https://example.com/p");
});

test("assertAllowedUrl allowPrivate bypasses the guard", async () => {
  await expect(assertAllowedUrl("http://192.168.1.1/", true, privateLookup)).resolves.toBeInstanceOf(URL);
});

test("LocalFetchProvider extracts main content as markdown, dropping boilerplate", async () => {
  const html =
    "<html><head><title>The Page</title></head><body>" +
    "<nav>MENU HOME</nav>" +
    "<article><h1>Real Heading</h1><p>This is the actual article body with enough words to be treated as content, and a <a href=\"https://x.com\">link</a>.</p></article>" +
    "<footer>footer junk</footer></body></html>";
  const p = new LocalFetchProvider(opts({ fetchImpl: (async () => htmlRes(html)) as unknown as typeof fetch }));
  const r = await p.fetch("https://example.com/post");
  expect(r.content).toContain("Real Heading");
  expect(r.content).toContain("[link](https://x.com)");
  expect(r.content).not.toContain("MENU");
  expect(r.content).not.toContain("footer junk");
  expect(r.title.length).toBeGreaterThan(0);
  expect(r.truncated).toBe(false);
});

test("LocalFetchProvider caps content to maxChars", async () => {
  const html = "<html><body><p>" + "word ".repeat(4000) + "</p></body></html>";
  const p = new LocalFetchProvider(opts({ maxChars: 200, fetchImpl: (async () => htmlRes(html)) as unknown as typeof fetch }));
  const r = await p.fetch("https://example.com/");
  expect(r.truncated).toBe(true);
  expect(r.content).toContain("truncated");
});

test("LocalFetchProvider follows redirects and re-checks each hop", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/a")) return new Response(null, { status: 302, headers: { location: "https://example.com/b" } });
    return htmlRes("<html><body><article><h1>Dest</h1><p>" + "ok ".repeat(30) + "</p></article></body></html>");
  }) as unknown as typeof fetch;
  const p = new LocalFetchProvider(opts({ fetchImpl }));
  const r = await p.fetch("https://example.com/a");
  expect(r.content).toContain("Dest");
  expect(r.url).toBe("https://example.com/b");
});

test("LocalFetchProvider rejects a redirect into a private address (SSRF)", async () => {
  const fetchImpl = (async () =>
    new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })) as unknown as typeof fetch;
  const p = new LocalFetchProvider(opts({ fetchImpl }));
  await expect(p.fetch("https://example.com/a")).rejects.toThrow(/private|reserved/);
});

test("non-HTML (JSON/plain text) is returned verbatim as format:text, not markdown", async () => {
  const json = '{"ok":true,"items":[1,2,3]}';
  const res = new Response(json, { headers: { "content-type": "application/json" } });
  const p = new LocalFetchProvider(opts({ fetchImpl: (async () => res) as unknown as typeof fetch }));
  const r = await p.fetch("https://api.example.com/data.json");
  expect(r.format).toBe("text");
  expect(r.content).toBe(json);
});

test("HTML extraction and negotiated markdown both report format:markdown", async () => {
  const htmlP = new LocalFetchProvider(opts({ fetchImpl: (async () => htmlRes("<html><body><article><h1>Hi</h1><p>" + "x ".repeat(30) + "</p></article></body></html>")) as unknown as typeof fetch }));
  expect((await htmlP.fetch("https://example.com/")).format).toBe("markdown");
  const mdRes = new Response("# T\n\nbody", { headers: { "content-type": "text/markdown" } });
  const mdP = new LocalFetchProvider(opts({ fetchImpl: (async () => mdRes) as unknown as typeof fetch }));
  expect((await mdP.fetch("https://example.com/")).format).toBe("markdown");
});

test("markdown served directly is used verbatim (content negotiation), title from H1", async () => {
  const md = "# Real Title\n\nSome **markdown** body with a [link](https://x.com).";
  const res = new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  const p = new LocalFetchProvider(opts({ fetchImpl: (async () => res) as unknown as typeof fetch }));
  const r = await p.fetch("https://docs.example.com/page");
  expect(r.title).toBe("Real Title");
  expect(r.content).toBe(md); // verbatim — no HTML round-trip
});

test("an RSS feed renders as a clean markdown item list, not HTML mush", async () => {
  const xml =
    '<?xml version="1.0"?><rss version="2.0"><channel><title>My Feed</title>' +
    "<item><title>Hello World</title><link>https://ex.com/1</link><pubDate>Wed, 05 Aug 2026</pubDate>" +
    "<description><![CDATA[<p>Some <b>summary</b> text.</p>]]></description></item>" +
    "<item><title>Second</title><link>https://ex.com/2</link></item></channel></rss>";
  const res = new Response(xml, { headers: { "content-type": "application/rss+xml" } });
  const p = new LocalFetchProvider(opts({ fetchImpl: (async () => res) as unknown as typeof fetch }));
  const r = await p.fetch("https://ex.com/feed.xml");
  expect(r.title).toBe("My Feed");
  expect(r.content).toContain("# My Feed");
  expect(r.content).toContain("[Hello World](https://ex.com/1)");
  expect(r.content).toContain("Some summary text"); // HTML tags stripped from the snippet
  expect(r.content).not.toContain("CDATA");
  expect(r.content).toContain("[Second](https://ex.com/2)");
});

test("an Atom feed uses the alternate link and entry titles", async () => {
  const xml =
    '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed</title>' +
    '<entry><title>Post A</title><link rel="alternate" href="https://ex.com/a"/><updated>2026-08-05</updated><summary>Sum A</summary></entry></feed>';
  const res = new Response(xml, { headers: { "content-type": "application/atom+xml" } });
  const p = new LocalFetchProvider(opts({ fetchImpl: (async () => res) as unknown as typeof fetch }));
  const r = await p.fetch("https://ex.com/atom");
  expect(r.title).toBe("Atom Feed");
  expect(r.content).toContain("[Post A](https://ex.com/a)");
});

test("rewriteForFetch maps GitHub URLs to raw content/READMEs", () => {
  expect(rewriteForFetch("https://github.com/o/r/blob/main/src/x.ts"))
    .toBe("https://raw.githubusercontent.com/o/r/main/src/x.ts");
  expect(rewriteForFetch("https://github.com/o/r"))
    .toBe("https://raw.githubusercontent.com/o/r/HEAD/README.md"); // repo root → README
  expect(rewriteForFetch("https://github.com/o/r/"))
    .toBe("https://raw.githubusercontent.com/o/r/HEAD/README.md"); // trailing slash
  expect(rewriteForFetch("https://github.com/o/r/tree/dev/pkg"))
    .toBe("https://raw.githubusercontent.com/o/r/dev/pkg/README.md"); // dir → its README
  expect(rewriteForFetch("https://github.com/o")).toBe("https://github.com/o"); // user profile unchanged
  expect(rewriteForFetch("https://example.com/blob/main/x")).toBe("https://example.com/blob/main/x"); // non-github unchanged
});

test("a raw .md served as text/plain is prose-rendered (format:markdown, title from H1)", async () => {
  const res = new Response("# Readme\n\nhello", { headers: { "content-type": "text/plain" } });
  const p = new LocalFetchProvider(opts({ fetchImpl: (async () => res) as unknown as typeof fetch }));
  const r = await p.fetch("https://raw.githubusercontent.com/o/r/main/README.md");
  expect(r.format).toBe("markdown");
  expect(r.title).toBe("Readme");
});

test("a page with no extractable content returns a note, not an empty body", async () => {
  const shell = "<html><head><title>App</title></head><body><div id=root></div></body></html>"; // JS-rendered shell
  const p = new LocalFetchProvider(opts({ fetchImpl: (async () => htmlRes(shell)) as unknown as typeof fetch }));
  const r = await p.fetch("https://spa.example.com/about");
  expect(r.content.trim().length).toBeGreaterThan(0);
  expect(r.content).toContain("No readable content");
});

test("an HTTP error includes a snippet of the error body", async () => {
  const res = new Response("<html><body>Sorry, that page was not found here.</body></html>", { status: 404, headers: { "content-type": "text/html" } });
  const p = new LocalFetchProvider(opts({ fetchImpl: (async () => res) as unknown as typeof fetch }));
  await expect(p.fetch("https://example.com/missing")).rejects.toThrow(/404.*not found here/i);
});

test("a text file with a generic content-type passes through as raw text", async () => {
  const code = "fn main() {\n    println!(\"hi\");\n}\n";
  const res = new Response(code, { headers: { "content-type": "application/octet-stream" } });
  const p = new LocalFetchProvider(opts({ fetchImpl: (async () => res) as unknown as typeof fetch }));
  const r = await p.fetch("https://example.com/main.rs");
  expect(r.format).toBe("text");
  expect(r.content).toBe(code.trim());
});

test("actual binary content is not dumped as text", async () => {
  const bin = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x00, 0x99, 0xfe]); // NUL bytes → binary
  const res = new Response(bin, { headers: { "content-type": "application/octet-stream" } });
  const p = new LocalFetchProvider(opts({ fetchImpl: (async () => res) as unknown as typeof fetch }));
  const r = await p.fetch("https://example.com/blob.bin");
  expect(r.content).toContain("not rendered as text");
});

test("createFetchProvider honors the enabled flag", () => {
  expect(createFetchProvider({ enabled: false } as never)).toBeNull();
  expect(createFetchProvider({ enabled: true, maxBytes: 1, maxChars: 1, timeoutMs: 1, allowPrivate: false, userAgent: "x" }))
    .toBeInstanceOf(LocalFetchProvider);
});
