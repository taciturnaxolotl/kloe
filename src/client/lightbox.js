/*
 * A full-view overlay for a file attached to the conversation.
 *
 *   openLightbox(items, index)   items: [{ kind, url, name, href }]
 *
 * `kind` is "image" or "text". `url` is where the bytes are, `href` what a
 * download should point at. They differ for a staged upload, which is showing a
 * local object URL for bytes that also live in the blob store.
 *
 * Text files render through the same markdown path as the conversation, inside
 * a code fence tagged with the file's extension — so a .py opens highlighted,
 * by the same Shiki that highlights a code block in a reply, with no second
 * viewer to keep in step with the first.
 *
 * Deliberately not a gallery library: one file at a time, arrow keys between
 * the files of the group you clicked, Esc or a click outside to leave. What
 * people want from a thumbnail is "bigger, now" — everything past that is
 * somebody else's product.
 */
import { renderMarkdown } from "./md.js";

var el = null;
var items = [];
var at = 0;
var restoreFocus = null;

/** Cap on a previewed file: past this, the browser's own viewer is the tool. */
var MAX_TEXT = 512 * 1024;

/** The fence language for a filename — enrich.js aliases js/py/rs/yml itself. */
function langOf(name) {
  var dot = String(name || "").lastIndexOf(".");
  var ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (/^[a-z0-9+#]{1,12}$/.test(ext)) return ext;
  return "";
}

function renderText(item, stage) {
  var box = document.createElement("div");
  box.className = "lbtext";
  stage.replaceChildren(box);
  var note = document.createElement("div");
  note.className = "lbloading";
  note.textContent = "Loading…";
  box.appendChild(note);
  var want = item.url;
  fetch(item.url)
    .then(function (r) {
      return r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status));
    })
    .then(function (text) {
      if (!el || items[at] == null || items[at].url !== want) return; // moved on
      var body = text;
      if (body.length > MAX_TEXT) {
        body = body.slice(0, MAX_TEXT) + "\n…[truncated — download to read the rest]";
      }
      box.replaceChildren();
      var prose = document.createElement("div");
      prose.className = "block prose";
      box.appendChild(prose);
      // Fence the whole file. A stray ``` inside it would end the block early,
      // so the fence is longer than any run of backticks the file contains.
      var ticks = "```";
      var run = /`{3,}/g;
      var m = run.exec(body);
      while (m) {
        if (m[0].length >= ticks.length) ticks = "`".repeat(m[0].length + 1);
        m = run.exec(body);
      }
      renderMarkdown(prose, ticks + langOf(item.name) + "\n" + body + "\n" + ticks);
    })
    .catch(function () {
      note.textContent = "This file could not be loaded.";
    });
}

function renderImage(item, stage) {
  var img = document.createElement("img");
  img.className = "lbimg";
  img.alt = item.name || "";
  // An image that can't be decoded has nothing to show full-size either.
  img.addEventListener("error", closeLightbox);
  img.src = item.url;
  stage.replaceChildren(img);
}

function render() {
  var item = items[at];
  if (!item) return closeLightbox();
  var stage = el.querySelector(".lbstage");
  stage.classList.toggle("istext", item.kind === "text");
  if (item.kind === "text") renderText(item, stage);
  else renderImage(item, stage);
  el.querySelector(".lbname").textContent = item.name || "";
  el.querySelector(".lbcount").textContent = items.length > 1 ? at + 1 + " / " + items.length : "";
  var dl = el.querySelector(".lbdownload");
  dl.href = item.href || item.url;
  dl.setAttribute("download", item.name || "");
  var many = items.length > 1;
  el.querySelector(".lbprev").hidden = !many;
  el.querySelector(".lbnext").hidden = !many;
}

function step(by) {
  if (items.length < 2) return;
  at = (at + by + items.length) % items.length;
  render();
}

function onKey(e) {
  if (!el) return;
  if (e.key === "Escape") closeLightbox();
  // Arrows scroll a long file; they only page between files when there is a
  // group to page through and nothing scrollable under the pointer.
  else if (e.key === "ArrowRight") step(1);
  else if (e.key === "ArrowLeft") step(-1);
  else return;
  e.preventDefault();
}

function build() {
  var box = document.createElement("div");
  box.className = "lightbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("tabindex", "-1");
  box.innerHTML =
    '<div class="lbbar">' +
    '<span class="lbname"></span>' +
    '<span class="lbcount"></span>' +
    '<a class="lbbtn lbdownload" title="Download">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>' +
    "</a>" +
    '<button class="lbbtn lbclose" type="button" aria-label="Close">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>' +
    "</button>" +
    "</div>" +
    '<button class="lbnav lbprev" type="button" aria-label="Previous image">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>' +
    "</button>" +
    '<button class="lbnav lbnext" type="button" aria-label="Next image">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>' +
    "</button>" +
    '<div class="lbstage"></div>';

  // A click on the backdrop (the stage, not the image) closes — the standard
  // gesture, and the reason the image is wrapped rather than a direct child.
  box.addEventListener("click", function (e) {
    if (e.target === box || e.target.classList.contains("lbstage")) closeLightbox();
  });
  box.querySelector(".lbclose").addEventListener("click", closeLightbox);
  box.querySelector(".lbprev").addEventListener("click", function () {
    step(-1);
  });
  box.querySelector(".lbnext").addEventListener("click", function () {
    step(1);
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(box);
  return box;
}

export function openLightbox(list, index) {
  if (!list || !list.length) return;
  closeLightbox(); // never stack two sheets, whatever state we were left in
  items = list;
  at = Math.max(0, Math.min(index || 0, list.length - 1));
  if (!el) el = build();
  restoreFocus = document.activeElement;
  render();
  // Behind the overlay the page must not scroll — a thread moving under a
  // full-screen image is disorienting when you close it.
  document.body.classList.add("lb-open");
  el.focus();
}

/**
 * Close, and leave nothing behind that could swallow the page.
 *
 * This overlay is `position: fixed; inset: 0`, so a copy left in the DOM is an
 * invisible sheet over the whole app that eats every wheel event — the page
 * looks fine and simply stops scrolling. That failure mode is bad enough, and
 * silent enough, that closing does not trust its own bookkeeping: it sweeps any
 * `.lightbox` node and clears the scroll lock whether or not this module thinks
 * one is open.
 */
export function closeLightbox() {
  document.removeEventListener("keydown", onKey);
  for (const stray of document.querySelectorAll(".lightbox")) stray.remove();
  el = null;
  items = [];
  document.body.classList.remove("lb-open");
  if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
  restoreFocus = null;
}
