/*
 * Reusable in-app confirm dialog, shared across pages. mountConfirm() injects
 * the markup once and returns askConfirm(opts) -> Promise<boolean>.
 *   opts: { title, body, ok, danger }
 * The OK button is focused so Enter confirms; Esc / backdrop / Cancel resolve
 * false. Styling lives in app.css (.confirm*).
 */
var HTML =
  '<div class="confirm-back"></div>' +
  '<div class="confirm-card" role="alertdialog" aria-modal="true">' +
    '<div class="confirm-title"></div>' +
    '<div class="confirm-body"></div>' +
    '<div class="confirm-actions">' +
      '<button class="btn confirm-cancel" type="button">Cancel</button>' +
      '<button class="btn confirm-ok" type="button">Confirm</button>' +
    '</div>' +
  '</div>';

export function mountConfirm() {
  var el = document.createElement("div");
  el.className = "confirm"; el.hidden = true; el.innerHTML = HTML;
  document.body.appendChild(el);

  var title = el.querySelector(".confirm-title"), body = el.querySelector(".confirm-body"),
      ok = el.querySelector(".confirm-ok"), cancel = el.querySelector(".confirm-cancel"),
      back = el.querySelector(".confirm-back");
  var resolve = null;
  function close(result) {
    if (el.hidden) return;
    el.hidden = true;
    var r = resolve; resolve = null;
    if (r) r(result);
  }
  ok.addEventListener("click", function () { close(true); });
  cancel.addEventListener("click", function () { close(false); });
  back.addEventListener("click", function () { close(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !el.hidden) close(false); });

  return function askConfirm(opts) {
    opts = opts || {};
    title.textContent = opts.title || "Are you sure?";
    body.textContent = opts.body || "";
    ok.textContent = opts.ok || "Confirm";
    ok.className = "btn confirm-ok " + (opts.danger ? "danger" : "primary");
    el.hidden = false;
    ok.focus();
    return new Promise(function (r) { resolve = r; });
  };
}
