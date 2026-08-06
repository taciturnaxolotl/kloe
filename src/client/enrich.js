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
  "c#": "c",
  golang: "go",
};
var _hl = null;
async function highlighter() {
  if (!_hl) {
    var core = await import("shiki/core");
    var eng = await import("shiki/engine/javascript");
    _hl = await core.createHighlighterCore({
      themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
      langs: Object.keys(LANGS).map(function (k) {
        return LANGS[k]();
      }),
      engine: eng.createJavaScriptRegexEngine(),
    });
  }
  return _hl;
}
async function highlightCode(code, lang) {
  var hl = await highlighter();
  lang = (lang || "").toLowerCase();
  lang = ALIAS[lang] || lang;
  if (!LANGS[lang]) lang = "text"; // plaintext is always available in core
  // defaultColor:false → every token carries --shiki-light/--shiki-dark vars and
  // no fixed color, so the app theme picks one (see .hl in app.css).
  return hl.codeToHtml(code, {
    lang: lang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
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
