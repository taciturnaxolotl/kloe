/*
 * A full-view overlay for images already on screen.
 *
 *   openLightbox(items, index)   items: [{ url, name, href }]
 *
 * `url` is what to display, `href` what to download. They differ for a staged
 * upload, which is showing a local object URL for bytes that also live in the
 * blob store.
 *
 * Deliberately not a gallery library: one image at a time, arrow keys between
 * the images of the group you clicked, Esc or a click outside to leave. The
 * thing people actually want from a thumbnail is "bigger, now" — everything
 * past that is somebody else's product.
 */
var el = null;
var items = [];
var at = 0;
var restoreFocus = null;

function render() {
  var item = items[at];
  if (!item) return closeLightbox();
  var img = el.querySelector(".lbimg");
  img.src = item.url;
  img.alt = item.name || "";
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
    '<div class="lbstage"><img class="lbimg" alt=""></div>';

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
  // An image that can't be decoded has nothing to show full-size either.
  box.querySelector(".lbimg").addEventListener("error", closeLightbox);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(box);
  return box;
}

export function openLightbox(list, index) {
  if (!list || !list.length) return;
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

export function closeLightbox() {
  if (!el) return;
  document.removeEventListener("keydown", onKey);
  el.remove();
  el = null;
  items = [];
  document.body.classList.remove("lb-open");
  if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
  restoreFocus = null;
}
