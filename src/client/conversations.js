/*
 * The dedicated Conversations page: an always-open search over titles AND
 * message contents (GET /api/conversations?q=), a per-row ⋮ menu, and a bulk
 * select/delete mode (DELETE /api/conversations/:id). The sidebar is shared
 * with the chat SPA; opening a row navigates to /c/<id>, "New chat" to /?new.
 */
import { mountSidebar } from "./sidebar.js";
import { mountDialogs } from "./confirm.js";
import { openChatMenu } from "./chatmenu.js";
import { requireAuth, setPfp } from "./authguard.js";
import { CONV_ICON, MORE_ICON as MORE } from "./icons.js";

(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var rows = $("rows"), search = $("search"), clearSearch = $("clearSearch");
  var selectBtn = $("selectBtn"), deleteBtn = $("deleteBtn"), selCount = $("selCount"), selectAllBtn = $("selectAllBtn");
  var dialogs = mountDialogs();

  var sidebar = mountSidebar({
    onSelect: function (id) { window.location.href = "/c/" + encodeURIComponent(id); },
    onNew: function () { window.location.href = "/?new=1"; },
    onOpenList: function () { search.focus(); },
    active: "conversations",
    dialogs: dialogs,
    reload: function () { reloadAll(); },
  });

  var conversations = []; // full list (for the sidebar recents)
  var selectMode = false;
  var searchTimer = null, searchSeq = 0;

  // "Today" / "Yesterday" / "Jun 6" / "Jun 6, 2024" — a compact last-active date.
  function fmtDate(ms) {
    var d = new Date(ms), now = new Date();
    var startOfDay = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    var opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  function checks() { return Array.prototype.slice.call(rows.querySelectorAll(".chatcheck")); }
  function selectedIds() {
    return checks().filter(function (c) { return c.checked; })
      .map(function (c) { return c.closest(".chatrow").dataset.id; });
  }
  // Delete only appears once something is actually selected.
  function allChecked() {
    var cs = checks();
    return cs.length > 0 && cs.every(function (c) { return c.checked; });
  }
  function updateDeleteBtn() {
    var n = selectedIds().length;
    deleteBtn.hidden = n === 0;
    deleteBtn.textContent = "Delete";
    selCount.textContent = n + " selected";
    selectAllBtn.textContent = allChecked() ? "Deselect all" : "Select all";
  }
  function setSelectMode(on) {
    selectMode = on;
    document.body.classList.toggle("selecting", on);
    selectBtn.textContent = on ? "Cancel" : "Select";
    if (!on) checks().forEach(function (c) { c.checked = false; });
    updateDeleteBtn();
  }


  async function reloadAll() { await loadSidebar(); loadMain(search.value.trim()); }

  async function deleteIds(ids) {
    if (!ids.length) return;
    var plural = ids.length > 1 ? "s" : "";
    var ok = await dialogs.confirm({
      title: "Delete " + ids.length + " conversation" + plural + "?",
      body: "This can't be undone.",
      ok: "Delete",
      danger: true,
    });
    if (!ok) return;
    await Promise.all(ids.map(function (id) {
      return fetch("/api/conversations/" + encodeURIComponent(id), { method: "DELETE" }).catch(function () {});
    }));
    setSelectMode(false);
    reloadAll();
  }

  function renderRows(list, q) {
    rows.innerHTML = "";
    if (!list.length) {
      var e = document.createElement("div");
      e.className = "chatsempty";
      e.textContent = q ? "No conversations match “" + q + "”" : "No conversations yet";
      rows.appendChild(e);
      return;
    }
    list.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "chatrow"; row.dataset.id = c.id;

      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.className = "chatcheck"; cb.setAttribute("aria-label", "Select conversation");

      var main = document.createElement("div");
      main.className = "chatmain";
      var t = document.createElement("div");
      t.className = "chattitle"; t.textContent = c.title || "Untitled";
      main.appendChild(t);
      if (c.snippet && c.snippet !== c.title) {
        var s = document.createElement("div");
        s.className = "chatsnip"; s.textContent = c.snippet;
        main.appendChild(s);
      }

      // The date holds the slot; the ⋮ overlays it (absolute) and fades in on
      // hover, so revealing it never reflows the row.
      var end = document.createElement("div");
      end.className = "chatend";
      var date = document.createElement("div");
      date.className = "chatdate"; date.textContent = fmtDate(c.updatedAt || c.createdAt);
      var more = document.createElement("button");
      more.className = "chatmore"; more.type = "button";
      more.setAttribute("aria-label", "Conversation options"); more.innerHTML = MORE;
      end.appendChild(date); end.appendChild(more);

      var icon = document.createElement("span");
      icon.className = "chaticon"; icon.innerHTML = CONV_ICON;
      row.appendChild(cb); row.appendChild(icon); row.appendChild(main); row.appendChild(end);

      function openMenu(x, y) {
        openChatMenu(x, y, {
          id: c.id, title: c.title, dialogs: dialogs, reload: reloadAll,
          extra: [{ label: "Select", onClick: function () {
            if (!selectMode) setSelectMode(true);
            cb.checked = true; updateDeleteBtn();
          } }],
        });
      }
      row.addEventListener("click", function () {
        if (selectMode) { cb.checked = !cb.checked; updateDeleteBtn(); }
        else window.location.href = "/c/" + encodeURIComponent(c.id);
      });
      row.addEventListener("contextmenu", function (ev) { ev.preventDefault(); openMenu(ev.clientX, ev.clientY); });
      cb.addEventListener("click", function (ev) { ev.stopPropagation(); updateDeleteBtn(); });
      more.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var r = more.getBoundingClientRect();
        openMenu(r.right, r.bottom + 4);
      });

      rows.appendChild(row);
    });
  }

  async function loadSidebar() {
    try {
      var r = await fetch("/api/conversations");
      conversations = ((await r.json()).conversations) || [];
    } catch (_) { conversations = []; }
    sidebar.render(conversations);
  }
  async function loadMain(q) {
    if (!q) { renderRows(conversations, ""); return; }
    var mine = ++searchSeq;
    try {
      var r = await fetch("/api/conversations?q=" + encodeURIComponent(q));
      var list = ((await r.json()).conversations) || [];
      if (mine === searchSeq) renderRows(list, q);
    } catch (_) {
      if (mine === searchSeq) rows.innerHTML = '<div class="chatsempty">Failed to load conversations</div>';
    }
  }

  selectBtn.addEventListener("click", function () { setSelectMode(!selectMode); });
  selectAllBtn.addEventListener("click", function () {
    var check = !allChecked();
    checks().forEach(function (c) { c.checked = check; });
    updateDeleteBtn();
  });
  deleteBtn.addEventListener("click", function () { deleteIds(selectedIds()); });
  function syncClear() { clearSearch.hidden = search.value.length === 0; }
  search.addEventListener("input", function () {
    syncClear();
    clearTimeout(searchTimer);
    var q = search.value.trim();
    searchTimer = setTimeout(function () { loadMain(q); }, 160);
  });
  clearSearch.addEventListener("click", function () {
    search.value = ""; syncClear(); search.focus(); loadMain("");
  });

  (async function () {
    var me = await requireAuth();
    if (!me) return; // redirecting to login
    setPfp(me);
    await loadSidebar();
    loadMain("");
    search.focus();
  })();
})();
