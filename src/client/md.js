/*
 * Markdown into DOM, and the guards that make that safe.
 *
 * Shared by the chat (src/client/app.js), which streams text into it a delta at
 * a time, and the public share page (src/client/share.js), which renders one
 * finished document. Both put MODEL-authored text on screen, so the hardening
 * below has to be one implementation: a second copy would be a second thing to
 * remember when the rules change.
 *
 * smd never emits raw HTML — model text lands in text nodes — so there is no
 * untrusted markup to sanitize and no need for a heavyweight sanitizer. That
 * leaves href/src as the only injection vector, which `makeRenderer` guards.
 */
import * as smd from "streaming-markdown";

// Lazily load the enrichment bundle (Shiki + KaTeX) from /assets on first code
// or math block. The URL is computed so the app bundler leaves it external —
// the heavy grammars never touch the app entry, and text-only chats never
// fetch them. Fail-soft: if it can't load, prose stays as plain markdown.
var _enrichMod;
export function enrichMod() {
  if (!_enrichMod) {
    _enrichMod = import(new URL("/assets/enrich.js", document.baseURI).href).catch(function () {
      return {};
    });
  }
  return _enrichMod;
}
export function enrich(el) {
  enrichMod().then(function (m) {
    if (m.enrich) m.enrich(el);
  });
}
// ---- streaming-markdown rendering --------------------------------------
// Wrap smd's default renderer to harden URLs. smd never emits raw HTML tags
// (model text lands in text nodes), so href/src are the only injection
// vector — we neutralize dangerous schemes and reveal external link targets.
// Math ($…$/$$…$$) collides badly with markdown: smd's own equation tokenizer
// swallows whole sections on a mispaired `$`, and its `_ * \` handling would
// otherwise mangle LaTeX (subscripts→emphasis, `\,`→`,`). So for complete text
// (protectMath) we wrap each math span — OUTSIDE code — in backticks, which smd
// preserves verbatim, tagged with MATH_MARK for enrich.js to KaTeX-render.
// Stray/unmatched `$` (and every `$` on the streaming path, where we don't have
// the full text to scan) are masked to DOLLAR_MASK so smd's tokenizer never
// fires; add_text restores those to a literal `$`. smdParserWrite is a raw
// handle so smdWrite doesn't recurse.
export var MATH_MARK = String.fromCharCode(0xe000); // prefix inside a wrapped-math <code>
export var DOLLAR_MASK = String.fromCharCode(0xe001); // masked `$`, restored by add_text
export var UND_MASK = String.fromCharCode(0xe002); // masked intraword `_`, restored by add_text
var smdParserWrite = smd.parser_write;

// CommonMark leaves an underscore alone when word characters sit on both sides
// of it — `read_file` is a name, not emphasis, and `single_choice or
// multi_choice` is two names rather than one italic phrase. smd applies no such
// rule, so every snake_case identifier a model writes comes out as "single" +
// italic "choice or multi" + "choice", underscores eaten and the words run
// together. Mask those so smd's tokenizer never sees them; add_text puts them
// back. Underscores that could really be emphasis (` _like this_ `, `__init__`)
// are left exactly as they are.
var INTRAWORD_UND = /(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu;
function maskUnderscores(text) {
  return text.indexOf("_") < 0 ? text : text.replace(INTRAWORD_UND, maskRun);
}
function maskRun(run) {
  return UND_MASK.repeat(run.length);
}
function maskAll(text) {
  var out = maskUnderscores(text);
  return out.indexOf("$") < 0 ? out : out.split("$").join(DOLLAR_MASK);
}
// A chunk that ends mid-name ("…single_" then "choice…") can't tell yet whether
// its last underscores are intraword, so that much waits for the next chunk —
// the word character before them comes along for the ride, since it is what the
// test needs. smdEnd flushes whatever is still held.
var HELD = new WeakMap(); // parser -> a trailing `<word>_+` waiting on its next neighbour
var HOLD_RE = /[\p{L}\p{N}]_+$/u;
export function smdWrite(parser, text) {
  var held = HELD.get(parser);
  if (held) {
    HELD.delete(parser);
    text = held + text;
  }
  var m = HOLD_RE.exec(text);
  if (m) {
    HELD.set(parser, m[0]);
    text = text.slice(0, text.length - m[0].length);
  }
  if (text) smdParserWrite(parser, maskAll(text));
}
/** Ends a parser started by `smdWrite`, writing back anything it was holding. */
export function smdEnd(parser) {
  var held = HELD.get(parser);
  if (held) {
    HELD.delete(parser);
    smdParserWrite(parser, maskAll(held));
  }
  smd.parser_end(parser);
}
// Match $$…$$ (display) or $…$ (inline) at src[i]; mirrors smd's rule that `$`
// before a digit/space is not math (so "$5" stays currency). Returns null if no
// balanced span starts here.
function matchDollar(src, i) {
  if (src[i + 1] === "$") {
    var close = src.indexOf("$$", i + 2);
    if (close > i + 1) {
      var d = src.slice(i + 2, close);
      if (d.trim() && d.indexOf("\n\n") < 0) return { tex: d, display: true, end: close + 2 };
    }
    return null;
  }
  var nx = src[i + 1];
  if (!nx || nx === " " || nx === "\n" || nx === "\t" || (nx >= "0" && nx <= "9")) return null;
  for (var j = i + 1; j < src.length; j++) {
    if (src[j] === "\n") return null;
    if (src[j] === "$") {
      var t = src.slice(i + 1, j);
      return t ? { tex: t, display: false, end: j + 1 } : null;
    }
  }
  return null;
}
// Wrap math spans in backticks (code is preserved verbatim by smd) so their
// LaTeX survives; skip fenced/inline code so real `$` there is untouched. O(n):
// sticky regexes match at the cursor without slicing, and untouched runs are
// copied in one slice at the next math/stray-`$` (never char-by-char).
var FENCE_RE = /[ \t]*(`{3,}|~{3,})/y;
var TICK_RE = /`+/y;
export function protectMath(src) {
  if (src.indexOf("$") < 0) return src;
  var parts = [],
    i = 0,
    n = src.length,
    fence = null,
    plain = 0;
  while (i < n) {
    if (i === 0 || src[i - 1] === "\n") {
      FENCE_RE.lastIndex = i;
      var fm = FENCE_RE.exec(src); // sticky → only matches at i
      if (fm) {
        if (!fence) fence = fm[1][0];
        else if (fm[1][0] === fence) fence = null;
        var e = src.indexOf("\n", i);
        i = e < 0 ? n : e + 1;
        continue; // stays in `plain`
      }
    }
    if (fence) {
      var e2 = src.indexOf("\n", i);
      i = e2 < 0 ? n : e2 + 1;
      continue;
    }
    var c = src[i];
    if (c === "`") {
      // inline code span → copy verbatim (stays in `plain`)
      TICK_RE.lastIndex = i;
      var run = TICK_RE.exec(src)[0];
      var cl = src.indexOf(run, i + run.length);
      i = cl < 0 ? n : cl + run.length;
      continue;
    }
    if (c === "$") {
      var m = matchDollar(src, i);
      if (i > plain) parts.push(src.slice(plain, i));
      if (m && m.tex.indexOf("`") < 0) {
        parts.push("`" + MATH_MARK + (m.display ? "D" : "") + m.tex + "`");
        i = m.end;
      } else {
        parts.push(DOLLAR_MASK);
        i++;
      } // stray/unwrappable `$` → literal
      plain = i;
      continue;
    }
    i++;
  }
  if (n > plain) parts.push(src.slice(plain, n));
  return parts.join("");
}
export function makeRenderer(root) {
  var r = smd.default_renderer(root);
  r._stripped = false;
  var baseAddText = r.add_text;
  r.add_text = function (data, text) {
    if (text.indexOf(DOLLAR_MASK) >= 0) text = text.split(DOLLAR_MASK).join("$");
    if (text.indexOf(UND_MASK) >= 0) text = text.split(UND_MASK).join("_");
    baseAddText(data, text);
  };
  var base = r.set_attr;
  r.set_attr = function (data, type, value) {
    // A code fence's language just became known — start fetching its grammar now
    // so the load overlaps the streaming text (helps first-use of a language).
    if (type === smd.LANG && value) {
      enrichMod().then(function (m) {
        if (m.preloadLang) m.preloadLang(value);
      });
    }
    var out = value;
    if (type === smd.HREF || type === smd.SRC) {
      if (/^\s*(javascript|vbscript|file):/i.test(value)) out = "#";
      else if (/^\s*data:/i.test(value) && !(type === smd.SRC && /^\s*data:image\//i.test(value)))
        out = "#";
      if (out !== value) r._stripped = true;
    }
    base(data, type, out);
    if (type === smd.HREF) {
      var node = data.nodes[data.index];
      if (node && node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
        node.setAttribute("title", out); // spec: show the full URL before navigating
      }
    }
  };
  return r;
}

/** A parser bound to a hardened renderer, for streaming text in a delta at a time. */
export function newParser(root) {
  var renderer = makeRenderer(root);
  return { renderer: renderer, parser: smd.parser(renderer) };
}
/**
 * Whether the renderer had to neutralize a URL while rendering. Callers surface
 * it; nothing depends on it being false.
 */
export function strippedUrl(renderer) {
  return !!(renderer && renderer._stripped);
}
/** A complete document, rendered into `el` in one pass and then enriched. */
export function renderMarkdown(el, text) {
  var np = newParser(el);
  smdWrite(np.parser, protectMath(text));
  smdEnd(np.parser);
  enrich(el);
  return strippedUrl(np.renderer);
}
