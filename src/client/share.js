/*
 * The public share page: one published document, and nothing else.
 *
 * A reader here may have no account and no session, so this page talks only to
 * /api/public/* — the routes that live outside the auth gate (see src/share.ts).
 * It deliberately shares no code with the chat shell beyond the markdown
 * renderer: no conversation state, no event stream, no sidebar. What loads is
 * what the document needs.
 *
 * The token comes from the path (/s/<token>) rather than a query string, so a
 * pasted link carries nothing else and a referrer leaks nothing else.
 */
import { renderMarkdown } from "./md.js";

var $ = function (id) {
  return document.getElementById(id);
};
var token = (location.pathname.match(/^\/s\/([0-9a-f]{32})$/) || [])[1];

function fail(message) {
  $("shareTitle").textContent = "Not available";
  document.title = "Not available · kloe";
  var p = document.createElement("p");
  p.className = "sharemiss";
  p.textContent = message;
  $("shareBody").replaceChildren(p);
}

/**
 * A published page, rendered as a page — in a frame that cannot reach this one.
 *
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, exactly as the chat's
 * own pane does it: the two together would hand the document our origin back
 * and undo the sandbox, so they must never both appear. This matters more here
 * than in the app, because the reader is a stranger to whoever wrote the page.
 */
function renderPage(text) {
  var frame = document.createElement("iframe");
  frame.className = "htmlframe";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc = text;
  $("shareBody").replaceChildren(frame);
}

function renderDoc(meta, text) {
  var body = $("shareBody");
  if (/^text\/html\b/.test(meta.mime)) {
    body.classList.add("isframe");
    renderPage(text);
    return;
  }
  var el = document.createElement("div");
  el.className = "block prose";
  body.replaceChildren(el);
  renderMarkdown(el, text);
}

/** Types the page can lay out itself. Anything else is offered as a download. */
function isReadable(mime) {
  return /^(text\/|application\/(json|xml)\b)/.test(mime);
}

function offerBytes(meta) {
  var p = document.createElement("p");
  p.className = "sharemiss";
  p.textContent = meta.name + " — " + meta.mime + ". Download it to open.";
  $("shareBody").replaceChildren(p);
}

(async function () {
  if (!token) return fail("This link is not a document link.");
  var meta;
  try {
    var res = await fetch("/api/public/" + token);
    if (!res.ok) throw new Error(String(res.status));
    meta = await res.json();
  } catch (_) {
    return fail("This link has expired, or was never published.");
  }
  var title = meta.title || meta.name;
  $("shareTitle").textContent = title;
  document.title = title + " · kloe";

  var dl = $("shareDownload");
  dl.hidden = false;
  dl.addEventListener("click", function () {
    // The public raw route sets Content-Disposition from the stored filename,
    // so the browser saves it under its real name without re-encoding bytes.
    var a = document.createElement("a");
    a.href = "/api/public/" + token + "/raw";
    a.download = meta.name;
    a.click();
  });

  if (!isReadable(meta.mime)) return offerBytes(meta);
  try {
    var raw = await fetch("/api/public/" + token + "/raw");
    if (!raw.ok) throw new Error(String(raw.status));
    renderDoc(meta, await raw.text());
  } catch (_) {
    fail("This document could not be loaded.");
  }
})();
