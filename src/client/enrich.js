/*
 * Progressive enhancement of rendered markdown, run once a block is COMPLETE
 * (message-end for a streamed turn, or immediately for static/replayed text) —
 * never per token. Two passes, both lazy-loaded on first use and fail-soft: a
 * failure leaves the plain, already-readable markdown in place.
 *
 *  - Code: highlighted with Shiki. Dual-theme (light/dark) via CSS variables so
 *    it follows the app theme with no re-highlighting; languages load on demand,
 *    so only grammars actually seen are fetched. Shiki inlines its colors, so
 *    there's no external stylesheet to ship.
 *  - Math: rendered with KaTeX. `$$…$$` is display, `$…$` is inline; code/pre
 *    and already-rendered nodes are skipped. KaTeX's CSS + fonts are served from
 *    node_modules at /vendor/ (see server.ts); its JS loads on first `$`.
 */

// ---- code (Shiki) ------------------------------------------------------
// Fine-grained bundle: only the curated langs + two themes + core + the JS
// regex engine (no WASM) are pulled in, each as a lazy chunk loaded on first
// highlight. Unknown languages fall back to plaintext (still boxed, no colors).
var LANGS = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  jsx: () => import("@shikijs/langs/jsx"),
  tsx: () => import("@shikijs/langs/tsx"),
  json: () => import("@shikijs/langs/json"),
  python: () => import("@shikijs/langs/python"),
  bash: () => import("@shikijs/langs/bash"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  sql: () => import("@shikijs/langs/sql"),
  yaml: () => import("@shikijs/langs/yaml"),
  markdown: () => import("@shikijs/langs/markdown"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  java: () => import("@shikijs/langs/java"),
  ruby: () => import("@shikijs/langs/ruby"),
  diff: () => import("@shikijs/langs/diff"),
  toml: () => import("@shikijs/langs/toml"),
  csharp: () => import("@shikijs/langs/csharp"),
  fsharp: () => import("@shikijs/langs/fsharp"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  zig: () => import("@shikijs/langs/zig"),
  nix: () => import("@shikijs/langs/nix"),
  php: () => import("@shikijs/langs/php"),
  lua: () => import("@shikijs/langs/lua"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  elixir: () => import("@shikijs/langs/elixir"),
  erlang: () => import("@shikijs/langs/erlang"),
  haskell: () => import("@shikijs/langs/haskell"),
  ocaml: () => import("@shikijs/langs/ocaml"),
  scala: () => import("@shikijs/langs/scala"),
  clojure: () => import("@shikijs/langs/clojure"),
  elm: () => import("@shikijs/langs/elm"),
  dart: () => import("@shikijs/langs/dart"),
  julia: () => import("@shikijs/langs/julia"),
  r: () => import("@shikijs/langs/r"),
  perl: () => import("@shikijs/langs/perl"),
  groovy: () => import("@shikijs/langs/groovy"),
  graphql: () => import("@shikijs/langs/graphql"),
  hcl: () => import("@shikijs/langs/hcl"),
  terraform: () => import("@shikijs/langs/terraform"),
  powershell: () => import("@shikijs/langs/powershell"),
  proto: () => import("@shikijs/langs/proto"),
  solidity: () => import("@shikijs/langs/solidity"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  xml: () => import("@shikijs/langs/xml"),
  ini: () => import("@shikijs/langs/ini"),
  makefile: () => import("@shikijs/langs/makefile"),
  cmake: () => import("@shikijs/langs/cmake"),
  latex: () => import("@shikijs/langs/latex"),
  gdscript: () => import("@shikijs/langs/gdscript"),
};
// Short/alternate names → a curated lang id.
var ALIAS = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  "f#": "fsharp",
  fs: "fsharp",
  golang: "go",
  kt: "kotlin",
  kts: "kotlin",
  docker: "dockerfile",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  clj: "clojure",
  cljs: "clojure",
  jl: "julia",
  pl: "perl",
  ps1: "powershell",
  pwsh: "powershell",
  tf: "terraform",
  sol: "solidity",
  gd: "gdscript",
  tex: "latex",
  protobuf: "proto",
};
// Memoize the highlighter PROMISE, not the resolved instance. Caching the
// resolved value lets concurrent callers (preloadLang, streamHl, enrichCode all
// fire at once) each pass the `if (!_hl)` check before the first await resolves,
// spawning a highlighter per call — and since `_loaded` tracks grammars against
// one instance, a different instance never has them and codeToHtml fails. One
// shared promise → one singleton instance, exactly as Shiki expects.
var _hlPromise = null;
function highlighter() {
  if (!_hlPromise) {
    _hlPromise = (async function () {
      var core = await import("shiki/core");
      var eng = await import("shiki/engine/javascript");
      // No grammars up front — each language loads lazily on first use (loadLang),
      // so a JS-only conversation costs one grammar, not all of them.
      return core.createHighlighterCore({
        themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
        langs: [],
        engine: eng.createJavaScriptRegexEngine(),
      });
    })();
  }
  return _hlPromise;
}
// lang id -> load promise, so concurrent highlights of the same language (a page
// full of code blocks on reload) trigger one grammar fetch, not one per block.
var _loaded = Object.create(null);
async function loadLang(hl, lang) {
  if (!LANGS[lang]) return "text"; // unknown → core plaintext (always available)
  if (!_loaded[lang]) _loaded[lang] = hl.loadLanguage(LANGS[lang]());
  try {
    await _loaded[lang];
    return lang;
  } catch (_) {
    return "text"; // grammar failed to load → still boxed, just uncolored
  }
}
async function highlightCode(code, lang) {
  var hl = await highlighter();
  lang = (lang || "").toLowerCase();
  lang = ALIAS[lang] || lang;
  lang = await loadLang(hl, lang);
  // defaultColor:false → every token carries --shiki-light/--shiki-dark vars and
  // no fixed color, so the app theme picks one (see .hl in app.css).
  return hl.codeToHtml(code, {
    lang: lang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
}
// Start loading a language's grammar (and the highlighter core) as soon as a code
// fence's language is known, so the fetch overlaps the streaming text instead of
// starting only when the first highlight pass runs. Fire-and-forget.
export function preloadLang(lang) {
  lang = (lang || "").toLowerCase();
  lang = ALIAS[lang] || lang;
  if (!LANGS[lang]) return;
  highlighter()
    .then(function (hl) {
      return loadLang(hl, lang);
    })
    .catch(function () {});
}

// smd sets the fence's language as the code element's class verbatim (`<code
// class="js">`), not the `language-js` convention — so read it straight, minus
// our own `hl` marker and the optional `language-` prefix.
function codeLang(el) {
  var classes = (el.getAttribute("class") || "").replace(/language-/g, "").split(/\s+/);
  for (var i = 0; i < classes.length; i++) {
    if (classes[i] && classes[i] !== "hl") return classes[i];
  }
  return "";
}
async function enrichCode(root) {
  var blocks = root.querySelectorAll("pre > code:not(.hl)");
  for (var i = 0; i < blocks.length; i++) {
    var el = blocks[i];
    try {
      var html = await highlightCode(el.textContent, codeLang(el));
      var tmp = document.createElement("template");
      tmp.innerHTML = html;
      var inner = tmp.content.querySelector("code");
      if (inner) {
        el.innerHTML = inner.innerHTML;
        el.classList.add("hl");
      }
    } catch (_) {
      /* leave the plain code block */
    }
  }
}

// Streaming highlight: the inner HTML (Shiki spans) for `text` in the code
// element's fenced language, returned so app.js can drop it into the live block
// and keep whatever streamed in while we highlighted. Null on failure → stay
// plain. Whole-block each call, so context changes (a `/` that becomes `//`)
// simply resolve — no token bookkeeping needed for a single active block.
export async function highlightInner(codeEl, text) {
  try {
    var html = await highlightCode(text, codeLang(codeEl));
    var tmp = document.createElement("template");
    tmp.innerHTML = html;
    var inner = tmp.content.querySelector("code");
    return inner ? inner.innerHTML : null;
  } catch (_) {
    return null;
  }
}

// ---- math (KaTeX) ------------------------------------------------------
var _katex = null;
// Inject KaTeX's stylesheet the first time math appears — the <link> is created
// here (not in the HTML), so the bundler never resolves it and the CSS + fonts
// load lazily from /vendor (served straight from node_modules; see server.ts).
function ensureKatexCss() {
  if (document.getElementById("katex-css")) return;
  var l = document.createElement("link");
  l.id = "katex-css";
  l.rel = "stylesheet";
  l.href = "/vendor/katex.min.css";
  document.head.appendChild(l);
}
async function katex() {
  if (!_katex) {
    ensureKatexCss();
    _katex = (await import("katex")).default;
  }
  return _katex;
}
// app.js (protectMath) wraps each math span in backticks — smd preserves code
// content verbatim, so the LaTeX survives markdown parsing intact — tagged with a
// leading MATH_MARK (U+E000) and a "D" for display. Those land as <code> elements;
// we KaTeX-render them and swap the <code> out. Real code has no MATH_MARK prefix
// and is left alone. throwOnError so invalid LaTeX shows its source, never red.
var _MATH_MARK = String.fromCharCode(0xe000);
async function enrichMath(root) {
  var codes = root.querySelectorAll("code");
  var maths = [];
  for (var i = 0; i < codes.length; i++) {
    if (codes[i].firstChild && codes[i].textContent.charCodeAt(0) === 0xe000) maths.push(codes[i]);
  }
  if (!maths.length) return; // no math → don't load katex
  var k = await katex();
  for (var j = 0; j < maths.length; j++) {
    var c = maths[j];
    var payload = c.textContent.slice(1); // drop MATH_MARK
    var display = payload.charAt(0) === "D";
    var tex = display ? payload.slice(1) : payload;
    var eq = document.createElement(display ? "equation-block" : "equation-inline");
    try {
      eq.innerHTML = k.renderToString(tex, { displayMode: display, throwOnError: true });
    } catch (_) {
      eq.textContent = tex;
    }
    c.replaceWith(eq);
  }
}

/** Enhance a finalized block: highlight code, render math. Fire-and-forget. */
export function enrich(root) {
  enrichCode(root).catch(function () {});
  enrichMath(root).catch(function () {});
}
