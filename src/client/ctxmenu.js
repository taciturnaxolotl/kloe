/*
 * A lightweight floating context menu shared across pages.
 *   showContextMenu(x, y, items, opts)   items: [{ label, danger, onClick }]
 * `opts.align` anchors the horizontal edge at x: "left" (default, menu opens
 * rightward — right for a cursor) or "right" (menu's right edge sits at x, so it
 * opens leftward — right for a ⋮ button at the right of a row). `opts.trigger`
 * is the element that opened the menu; re-invoking with the same trigger while
 * open toggles it shut. Only one is open at a time; it closes on outside click,
 * Esc, scroll, or resize, and is clamped to the viewport. Styling lives in
 * app.css (.ctxmenu).
 */
var current = null, currentTrigger = null, wired = false;

export function closeContextMenu() {
  if (current) { current.remove(); current = null; currentTrigger = null; }
}
function wire() {
  if (wired) return;
  wired = true;
  document.addEventListener("click", closeContextMenu);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeContextMenu(); });
  window.addEventListener("resize", closeContextMenu);
  window.addEventListener("scroll", closeContextMenu, true);
}

export function showContextMenu(x, y, items, opts) {
  opts = opts || {};
  // Re-clicking the same trigger (a ⋮ button) while its menu is open toggles it
  // shut, rather than closing and reopening an identical menu in place.
  if (current && opts.trigger && currentTrigger === opts.trigger) { closeContextMenu(); return; }
  closeContextMenu();
  wire();
  var menu = document.createElement("div");
  menu.className = "ctxmenu";
  items.forEach(function (it) {
    var b = document.createElement("button");
    b.type = "button";
    if (it.danger) b.className = "danger";
    if (it.icon) {
      var ic = document.createElement("span");
      ic.className = "ctxicon";
      ic.innerHTML = it.icon; // full <svg> string (see icons.js)
      b.appendChild(ic);
    }
    var label = document.createElement("span");
    label.textContent = it.label;
    b.appendChild(label);
    b.addEventListener("click", function (e) { e.stopPropagation(); closeContextMenu(); it.onClick(); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  var w = menu.offsetWidth, h = menu.offsetHeight;
  var left = opts.align === "right" ? x - w : x;
  menu.style.left = Math.max(6, Math.min(left, window.innerWidth - w - 6)) + "px";
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + "px";
  current = menu;
  currentTrigger = opts.trigger || null;
}
