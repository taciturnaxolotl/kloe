import { expect, test } from "bun:test";
import {
  assertAllowedUrl,
  createFetchProvider,
  detectBlockage,
  FlareSolverrRenderer,
  isPrivateIp,
  LocalFetchProvider,
  rewriteForFetch,
  structuredRescue,
} from "../src/fetch";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = async () => [{ address: "192.168.1.10", family: 4 }];

const opts = (over: Record<string, unknown> = {}) =>
  ({
    maxBytes: 1_000_000,
    maxChars: 50_000,
    timeoutMs: 5000,
    allowPrivate: false,
    userAgent: "test",
    lookupImpl: publicLookup,
    ...over,
  }) as never;
const htmlRes = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/html", ...(init.headers ?? {}) },
    ...init,
  });

test("isPrivateIp flags private/reserved addresses and allows public ones", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.5.4",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ])
    expect(isPrivateIp(ip)).toBe(true);
  for (const ip of ["93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    expect(isPrivateIp(ip)).toBe(false);
});

test("assertAllowedUrl rejects non-http, localhost, and private resolutions", async () => {
  await expect(assertAllowedUrl("ftp://x/", false, publicLookup)).rejects.toThrow(/scheme/);
  await expect(assertAllowedUrl("http://localhost/x", false, publicLookup)).rejects.toThrow(
    /localhost/,
  );
  await expect(assertAllowedUrl("http://internal.corp/", false, privateLookup)).rejects.toThrow(
    /private|reserved/,
  );
  await expect(
    assertAllowedUrl("http://169.254.169.254/latest", false, publicLookup),
  ).rejects.toThrow(/private|reserved/);
  const u = await assertAllowedUrl("https://example.com/p", false, publicLookup);
  expect(u.href).toBe("https://example.com/p");
});

test("assertAllowedUrl allowPrivate bypasses the guard", async () => {
  await expect(
    assertAllowedUrl("http://192.168.1.1/", true, privateLookup),
  ).resolves.toBeInstanceOf(URL);
});

test("LocalFetchProvider extracts main content as markdown, dropping boilerplate", async () => {
  const html =
    "<html><head><title>The Page</title></head><body>" +
    "<nav>MENU HOME</nav>" +
    '<article><h1>Real Heading</h1><p>This is the actual article body with enough words to be treated as content, and a <a href="https://x.com">link</a>.</p></article>' +
    "<footer>footer junk</footer></body></html>";
  const p = new LocalFetchProvider(
    opts({ fetchImpl: (async () => htmlRes(html)) as unknown as typeof fetch }),
  );
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
  const p = new LocalFetchProvider(
    opts({ maxChars: 200, fetchImpl: (async () => htmlRes(html)) as unknown as typeof fetch }),
  );
  const r = await p.fetch("https://example.com/");
  expect(r.truncated).toBe(true);
  expect(r.content).toContain("truncated");
});

test("LocalFetchProvider follows redirects and re-checks each hop", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/a"))
      return new Response(null, { status: 302, headers: { location: "https://example.com/b" } });
    return htmlRes(
      "<html><body><article><h1>Dest</h1><p>" + "ok ".repeat(30) + "</p></article></body></html>",
    );
  }) as unknown as typeof fetch;
  const p = new LocalFetchProvider(opts({ fetchImpl }));
  const r = await p.fetch("https://example.com/a");
  expect(r.content).toContain("Dest");
  expect(r.url).toBe("https://example.com/b");
});

test("LocalFetchProvider rejects a redirect into a private address (SSRF)", async () => {
  const fetchImpl = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    })) as unknown as typeof fetch;
  const p = new LocalFetchProvider(opts({ fetchImpl }));
  await expect(p.fetch("https://example.com/a")).rejects.toThrow(/private|reserved/);
});

test("non-HTML (JSON/plain text) is returned verbatim as format:text, not markdown", async () => {
  const json = '{"ok":true,"items":[1,2,3]}';
  const res = new Response(json, { headers: { "content-type": "application/json" } });
  const p = new LocalFetchProvider(
    opts({ fetchImpl: (async () => res) as unknown as typeof fetch }),
  );
  const r = await p.fetch("https://api.example.com/data.json");
  expect(r.format).toBe("text");
  expect(r.content).toBe(json);
});

test("HTML extraction and negotiated markdown both report format:markdown", async () => {
  const htmlP = new LocalFetchProvider(
    opts({
      fetchImpl: (async () =>
        htmlRes(
          "<html><body><article><h1>Hi</h1><p>" + "x ".repeat(30) + "</p></article></body></html>",
        )) as unknown as typeof fetch,
    }),
  );
  expect((await htmlP.fetch("https://example.com/")).format).toBe("markdown");
  const mdRes = new Response("# T\n\nbody", { headers: { "content-type": "text/markdown" } });
  const mdP = new LocalFetchProvider(
    opts({ fetchImpl: (async () => mdRes) as unknown as typeof fetch }),
  );
  expect((await mdP.fetch("https://example.com/")).format).toBe("markdown");
});

test("markdown served directly is used verbatim (content negotiation), title from H1", async () => {
  const md = "# Real Title\n\nSome **markdown** body with a [link](https://x.com).";
  const res = new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  const p = new LocalFetchProvider(
    opts({ fetchImpl: (async () => res) as unknown as typeof fetch }),
  );
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
  const p = new LocalFetchProvider(
    opts({ fetchImpl: (async () => res) as unknown as typeof fetch }),
  );
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
  const p = new LocalFetchProvider(
    opts({ fetchImpl: (async () => res) as unknown as typeof fetch }),
  );
  const r = await p.fetch("https://ex.com/atom");
  expect(r.title).toBe("Atom Feed");
  expect(r.content).toContain("[Post A](https://ex.com/a)");
});

test("rewriteForFetch maps GitHub URLs to raw content/READMEs", () => {
  expect(rewriteForFetch("https://github.com/o/r/blob/main/src/x.ts")).toBe(
    "https://raw.githubusercontent.com/o/r/main/src/x.ts",
  );
  expect(rewriteForFetch("https://github.com/o/r")).toBe(
    "https://raw.githubusercontent.com/o/r/HEAD/README.md",
  ); // repo root → README
  expect(rewriteForFetch("https://github.com/o/r/")).toBe(
    "https://raw.githubusercontent.com/o/r/HEAD/README.md",
  ); // trailing slash
  expect(rewriteForFetch("https://github.com/o/r/tree/dev/pkg")).toBe(
    "https://raw.githubusercontent.com/o/r/dev/pkg/README.md",
  ); // dir → its README
  expect(rewriteForFetch("https://github.com/o")).toBe("https://github.com/o"); // user profile unchanged
  expect(rewriteForFetch("https://example.com/blob/main/x")).toBe(
    "https://example.com/blob/main/x",
  ); // non-github unchanged
});

test("a raw .md served as text/plain is prose-rendered (format:markdown, title from H1)", async () => {
  const res = new Response("# Readme\n\nhello", { headers: { "content-type": "text/plain" } });
  const p = new LocalFetchProvider(
    opts({ fetchImpl: (async () => res) as unknown as typeof fetch }),
  );
  const r = await p.fetch("https://raw.githubusercontent.com/o/r/main/README.md");
  expect(r.format).toBe("markdown");
  expect(r.title).toBe("Readme");
});

test("a page with no extractable content returns a note, not an empty body", async () => {
  const shell = "<html><head><title>App</title></head><body><div id=root></div></body></html>"; // JS-rendered shell
  const p = new LocalFetchProvider(
    opts({ fetchImpl: (async () => htmlRes(shell)) as unknown as typeof fetch }),
  );
  const r = await p.fetch("https://spa.example.com/about");
  expect(r.content.trim().length).toBeGreaterThan(0);
  expect(r.content).toContain("No readable content");
});

test("an HTTP error includes a snippet of the error body", async () => {
  const res = new Response("<html><body>Sorry, that page was not found here.</body></html>", {
    status: 404,
    headers: { "content-type": "text/html" },
  });
  const p = new LocalFetchProvider(
    opts({ fetchImpl: (async () => res) as unknown as typeof fetch }),
  );
  await expect(p.fetch("https://example.com/missing")).rejects.toThrow(/404.*not found here/i);
});

test("a text file with a generic content-type passes through as raw text", async () => {
  const code = 'fn main() {\n    println!("hi");\n}\n';
  const res = new Response(code, { headers: { "content-type": "application/octet-stream" } });
  const p = new LocalFetchProvider(
    opts({ fetchImpl: (async () => res) as unknown as typeof fetch }),
  );
  const r = await p.fetch("https://example.com/main.rs");
  expect(r.format).toBe("text");
  expect(r.content).toBe(code.trim());
});

test("actual binary content is not dumped as text", async () => {
  const bin = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x00, 0x99, 0xfe]); // NUL bytes → binary
  const res = new Response(bin, { headers: { "content-type": "application/octet-stream" } });
  const p = new LocalFetchProvider(
    opts({ fetchImpl: (async () => res) as unknown as typeof fetch }),
  );
  const r = await p.fetch("https://example.com/blob.bin");
  expect(r.content).toContain("not rendered as text");
});

test("createFetchProvider honors the enabled flag", () => {
  expect(createFetchProvider({ enabled: false } as never)).toBeNull();
  expect(
    createFetchProvider({
      enabled: true,
      maxBytes: 1,
      maxChars: 1,
      timeoutMs: 1,
      allowPrivate: false,
      userAgent: "x",
      renderer: { provider: "none", endpoint: "", timeoutMs: 1000 },
      archive: false,
    }),
  ).toBeInstanceOf(LocalFetchProvider);
});

// ---- walls, shells, and the ladder out of them ------------------------------
// Three ways a fetch comes back with nothing, and each wants a different next
// move — which is the whole reason they're told apart.

test("detectBlockage names the vendor and whether a browser could help", () => {
  const h = (o: Record<string, string>) => new Headers(o);

  // Cloudflare says so outright on every challenge type.
  expect(detectBlockage(403, h({ "cf-mitigated": "challenge" }), "")).toEqual({
    vendor: "cloudflare",
    kind: "challenge",
  });
  expect(detectBlockage(503, h({}), "<title>Just a moment...</title>")).toMatchObject({
    vendor: "cloudflare",
    kind: "challenge",
  });
  expect(
    detectBlockage(403, h({ server: "cloudflare" }), "<h1>Attention Required!</h1> error 1020"),
  ).toEqual({ vendor: "cloudflare", kind: "denied" });

  // Other vendors carry their own tells.
  expect(detectBlockage(403, h({ "x-datadome": "protected" }), "")?.vendor).toBe("datadome");
  expect(detectBlockage(403, h({}), "Incapsula incident ID: 1-2-3")?.vendor).toBe("imperva");

  // An ordinary 404 is not a wall.
  expect(detectBlockage(404, h({}), "<h1>Not found</h1>")).toBeNull();
  expect(detectBlockage(200, h({}), "<p>a normal page</p>")).toBeNull();
});

test("a big page that extracts to nothing escalates; a short one doesn't", async () => {
  // The shell: 100KB of scripts, no text. This is what a JS-only page looks
  // like, and the only reliable signal is that we got nothing out of a lot.
  const shell = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div>${"<script>var x=1;</script>".repeat(400)}</body></html>`;
  let asked = 0;
  const p = new LocalFetchProvider(
    opts({
      archive: false,
      renderer: {
        render: async () => {
          asked++;
          return {
            url: "https://spa.test/",
            status: 200,
            html: `<html><body><article><h1>Rendered</h1><p>${"the real article text. ".repeat(20)}</p></article></body></html>`,
          };
        },
      },
      fetchImpl: async () => htmlRes(shell),
    }),
  );
  const r = await p.fetch("https://spa.test/");
  expect(asked).toBe(1);
  expect(r.via).toBe("rendered");
  expect(r.content).toContain("the real article text");

  // A genuinely short page is not a shell, and must not cost a render.
  let renders = 0;
  const small = new LocalFetchProvider(
    opts({
      archive: false,
      renderer: {
        render: async () => {
          renders++;
          throw new Error("should not be called");
        },
      },
      fetchImpl: async () => htmlRes("<html><body><p>Short but real.</p></body></html>"),
    }),
  );
  expect((await small.fetch("https://tiny.test/")).content).toContain("Short but real");
  expect(renders).toBe(0);
});

test("a challenge is rendered; the note says what was in the way", async () => {
  const p = new LocalFetchProvider(
    opts({
      archive: false,
      renderer: {
        render: async () => ({
          url: "https://walled.test/",
          status: 200,
          html: `<html><body><article><p>${"content behind the wall. ".repeat(20)}</p></article></body></html>`,
        }),
      },
      fetchImpl: async () =>
        new Response("<title>Just a moment...</title>", {
          status: 403,
          headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        }),
    }),
  );
  const r = await p.fetch("https://walled.test/");
  expect(r.via).toBe("rendered");
  expect(r.note).toContain("cloudflare challenge");
});

test("with no renderer, a blocked page fails with the reason, not a bare status", async () => {
  const p = new LocalFetchProvider(
    opts({
      archive: false,
      fetchImpl: async () =>
        new Response("<title>Just a moment...</title>", {
          status: 403,
          headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        }),
    }),
  );
  // The model needs to know it hit a wall — that's what makes it try a
  // different source instead of the same URL again.
  await expect(p.fetch("https://walled.test/")).rejects.toThrow(/cloudflare bot challenge/);
});

test("structuredRescue recovers what the page publishes for search engines", () => {
  const html = `<html><head><title>Fallback</title>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "NewsArticle", headline: "The Headline", articleBody: "A".repeat(300) },
      ],
    })}</script></head><body><div id="root"></div></body></html>`;
  const out = structuredRescue(html, "https://news.test/x");
  expect(out?.title).toBe("Fallback");
  expect(out?.markdown.startsWith("AAA")).toBe(true);

  // A headline with nothing behind it is not a rescue.
  expect(structuredRescue("<html><head><title>Just a title</title></head></html>", "u")).toBeNull();
});

test("the page's own AMP twin is tried before a browser is", async () => {
  const shell = `<!doctype html><html><head><link rel="amphtml" href="/amp/x"></head><body><div id="root"></div>${"<script>1</script>".repeat(400)}</body></html>`;
  let renders = 0;
  const p = new LocalFetchProvider(
    opts({
      archive: false,
      renderer: {
        render: async () => {
          renders++;
          throw new Error("should not be called");
        },
      },
      fetchImpl: async (url: string) =>
        htmlRes(
          url.includes("/amp/")
            ? `<html><body><article><p>${"amp article text. ".repeat(20)}</p></article></body></html>`
            : shell,
        ),
    }),
  );
  const r = await p.fetch("https://news.test/x");
  expect(r.via).toBe("amp");
  expect(r.content).toContain("amp article text");
  expect(renders).toBe(0); // the cheap rung worked, so the expensive one never ran
});

test("FlareSolverrRenderer speaks the v1 protocol and serializes its calls", async () => {
  const seen: string[] = [];
  let inFlight = 0;
  let overlapped = false;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    inFlight++;
    if (inFlight > 1) overlapped = true;
    seen.push(JSON.parse(String(init.body)).url);
    await Bun.sleep(5);
    inFlight--;
    return new Response(
      JSON.stringify({
        status: "ok",
        solution: { url: "https://x.test/", status: 200, response: "<html>ok</html>" },
      }),
    );
  }) as unknown as typeof fetch;
  const r = new FlareSolverrRenderer({
    endpoint: "http://box:8191/v1",
    timeoutMs: 1000,
    fetchImpl,
  });

  const [a, b] = await Promise.all([r.render("https://a.test/"), r.render("https://b.test/")]);
  expect(a.html).toBe("<html>ok</html>");
  expect(b.status).toBe(200);
  expect(seen).toEqual(["https://a.test/", "https://b.test/"]);
  // One browser, one page at a time: overlapping calls would queue behind each
  // other inside FlareSolverr anyway, and blow every caller's budget.
  expect(overlapped).toBe(false);
});

test("a renderer that errors leaves the failure explained, not swallowed", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ status: "error", message: "Challenge not solved!" }),
    )) as unknown as typeof fetch;
  const r = new FlareSolverrRenderer({ endpoint: "http://box:8191/v1", timeoutMs: 100, fetchImpl });
  await expect(r.render("https://x.test/")).rejects.toThrow(/Challenge not solved/);
});
