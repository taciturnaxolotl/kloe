/*
 * One conversation row, shared by the Conversations page and the Project page.
 * A `.chatrow` div (not a link — no underline) with an icon, title, an optional
 * snippet, a date that yields to a ⋮ button on hover, and the shared rename/
 * delete context menu (also on right-click). Callers vary it through opts:
 *
 *   dialogs, reload   — passed to the ⋮ menu's actions
 *   onOpen(c)         — click when not intercepted (default: navigate to /c/<id>)
 *   snippet           — show c.snippet under the title (search results)
 *   selectable        — render a checkbox and hand it back for select-mode
 *   onCheck()         — a selectable row's checkbox toggled
 *   onClick(c, ref)   — full click override; ref = { checkbox }
 *   extra(c, ref)     — extra menu items above Rename/Delete
 */
import { openChatMenu } from "./chatmenu.js";
import { CONV_ICON, MORE_ICON } from "./icons.js";

// "Today" / "Yesterday" / "Jun 6" / "Jun 6, 2024" — a compact last-active date.
export function fmtConvDate(ms) {
  var d = new Date(ms),
    now = new Date();
  var sod = function (x) {
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  };
  var days = Math.round((sod(now) - sod(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  var o = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
  return d.toLocaleDateString(undefined, o);
}

export function convRow(c, opts) {
  opts = opts || {};
  var row = document.createElement("div");
  row.className = "chatrow";
  row.dataset.id = c.id;

  var cb = null;
  if (opts.selectable) {
    cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "chatcheck";
    cb.setAttribute("aria-label", "Select conversation");
    cb.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (opts.onCheck) opts.onCheck();
    });
  }
  var ref = { checkbox: cb };

  var icon = document.createElement("span");
  icon.className = "chaticon";
  icon.innerHTML = CONV_ICON;

  var main = document.createElement("div");
  main.className = "chatmain";
  var t = document.createElement("div");
  t.className = "chattitle";
  t.textContent = c.title || "Untitled";
  main.appendChild(t);
  if (opts.snippet && c.snippet && c.snippet !== c.title) {
    var s = document.createElement("div");
    s.className = "chatsnip";
    s.textContent = c.snippet;
    main.appendChild(s);
  }

  // The date holds the slot; the ⋮ overlays it (absolute) and fades in on hover,
  // so revealing it never reflows the row.
  var end = document.createElement("div");
  end.className = "chatend";
  var date = document.createElement("div");
  date.className = "chatdate";
  date.textContent = fmtConvDate(c.updatedAt || c.createdAt);
  var more = document.createElement("button");
  more.className = "chatmore";
  more.type = "button";
  more.setAttribute("aria-label", "Conversation options");
  more.innerHTML = MORE_ICON;
  end.appendChild(date);
  end.appendChild(more);

  if (cb) row.appendChild(cb);
  row.appendChild(icon);
  row.appendChild(main);
  row.appendChild(end);

  function openMenu(x, y, align, trigger) {
    openChatMenu(x, y, {
      id: c.id,
      title: c.title,
      dialogs: opts.dialogs,
      reload: opts.reload,
      align: align,
      trigger: trigger,
      extra: opts.extra ? opts.extra(c, ref) : [],
    });
  }
  function open() {
    if (opts.onClick) opts.onClick(c, ref);
    else if (opts.onOpen) opts.onOpen(c);
    else window.location.href = "/c/" + encodeURIComponent(c.id);
  }
  row.addEventListener("click", open);
  // Right-click opens at the cursor (left-aligned); the ⋮ button sits at the
  // row's right edge, so its menu right-aligns to sit over the row, not past it.
  row.addEventListener("contextmenu", function (ev) {
    ev.preventDefault();
    openMenu(ev.clientX, ev.clientY);
  });
  more.addEventListener("click", function (ev) {
    ev.stopPropagation();
    var r = more.getBoundingClientRect();
    openMenu(r.right, r.bottom + 4, "right", more);
  });

  return row;
}
