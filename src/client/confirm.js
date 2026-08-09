/*
 * Reusable in-app dialogs, shared across pages. mountDialogs() injects the
 * markup once and returns { confirm, prompt }:
 *   confirm({ title, body, ok, danger }) -> Promise<boolean>
 *   prompt({ title, value, placeholder, ok, danger }) -> Promise<string|null>
 * OK is focused (confirm) / the field is focused+selected (prompt); Enter
 * commits, Esc / backdrop / Cancel resolve false / null. Styling: app.css.
 */
var HTML =
  '<div class="confirm-back"></div>' +
  '<div class="confirm-card" role="dialog" aria-modal="true">' +
  '<div class="confirm-title"></div>' +
  '<div class="confirm-body"></div>' +
  '<input class="confirm-input" name="value" type="text" autocomplete="off" spellcheck="false" hidden>' +
  '<div class="confirm-actions">' +
  '<button class="btn confirm-cancel" type="button">Cancel</button>' +
  '<button class="btn confirm-ok" type="button">Confirm</button>' +
  "</div>" +
  "</div>";

export function mountDialogs() {
  var el = document.createElement("div");
  el.className = "confirm";
  el.hidden = true;
  el.innerHTML = HTML;
  document.body.appendChild(el);

  var title = el.querySelector(".confirm-title"),
    body = el.querySelector(".confirm-body"),
    input = el.querySelector(".confirm-input"),
    ok = el.querySelector(".confirm-ok"),
    cancel = el.querySelector(".confirm-cancel"),
    back = el.querySelector(".confirm-back");
  var resolve = null,
    isPrompt = false;

  function done(committed) {
    if (el.hidden) return;
    el.hidden = true;
    var r = resolve;
    resolve = null;
    if (!r) return;
    r(isPrompt ? (committed ? input.value.trim() : null) : committed);
  }
  ok.addEventListener("click", function () {
    done(true);
  });
  cancel.addEventListener("click", function () {
    done(false);
  });
  back.addEventListener("click", function () {
    done(false);
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      done(true);
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !el.hidden) done(false);
  });

  function open(opts, prompt) {
    opts = opts || {};
    isPrompt = prompt;
    title.textContent = opts.title || "";
    body.textContent = opts.body || "";
    body.hidden = !opts.body;
    ok.textContent = opts.ok || (prompt ? "Save" : "Confirm");
    ok.className = "btn confirm-ok " + (opts.danger ? "danger" : "primary");
    input.hidden = !prompt;
    if (prompt) {
      input.value = opts.value || "";
      input.placeholder = opts.placeholder || "";
    }
    el.hidden = false;
    if (prompt) {
      input.focus();
      input.select();
    } else {
      ok.focus();
    }
    return new Promise(function (r) {
      resolve = r;
    });
  }
  return {
    confirm: function (opts) {
      return open(opts, false);
    },
    prompt: function (opts) {
      return open(opts, true);
    },
  };
}
