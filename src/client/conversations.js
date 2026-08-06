/*
 * The dedicated Conversations page: an always-open search over titles AND
 * message contents (GET /api/conversations?q=), a per-row ⋮ menu, and a bulk
 * select/delete mode (DELETE /api/conversations/:id). The sidebar is shared
 * with the chat SPA; opening a row navigates to /c/<id>, "New chat" to /?new.
 */

import { requireAuth, setPfp } from "./authguard.js";
import { mountDialogs } from "./confirm.js";
import { convRow } from "./convrow.js";
import { mountSidebar } from "./sidebar.js";

(function () {
  "use strict";
  var $ = function (id) {
    return document.getElementById(id);
  };
  var rows = $("rows"),
    search = $("search"),
    clearSearch = $("clearSearch");
  var selectBtn = $("selectBtn"),
    deleteBtn = $("deleteBtn"),
    selCount = $("selCount"),
    selectAllBtn = $("selectAllBtn");
  var dialogs = mountDialogs();

  var sidebar = mountSidebar({
    onSelect: function (id) {
      window.location.href = "/c/" + encodeURIComponent(id);
    },
    onNew: function () {
      window.location.href = "/?new=1";
    },
    onOpenList: function () {
      search.focus();
    },
    active: "conversations",
    dialogs: dialogs,
    reload: function () {
      reloadAll();
    },
  });

  var conversations = []; // full list (for the sidebar recents)
  var selectMode = false;
  var searchTimer = null,
    searchSeq = 0;

  // The full list survives a navigation in sessionStorage so the main rows (and
  // recents) paint instantly on the next visit; the fetch below revalidates.
  var LIST_CACHE = "kloe:conversations";
  function readListCache() {
    try {
      return JSON.parse(sessionStorage.getItem(LIST_CACHE) || "null");
    } catch (_) {
      return null;
    }
  }
  function writeListCache(list) {
    try {
      sessionStorage.setItem(LIST_CACHE, JSON.stringify(list || []));
    } catch (_) {}
  }

  function checks() {
    return Array.prototype.slice.call(rows.querySelectorAll(".chatcheck"));
  }
  function selectedIds() {
    return checks()
      .filter(function (c) {
        return c.checked;
      })
      .map(function (c) {
        return c.closest(".chatrow").dataset.id;
      });
  }
  // Delete only appears once something is actually selected.
  function allChecked() {
    var cs = checks();
    return (
      cs.length > 0 &&
      cs.every(function (c) {
        return c.checked;
      })
    );
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
    if (!on)
      checks().forEach(function (c) {
        c.checked = false;
      });
    updateDeleteBtn();
  }

  async function reloadAll() {
    await loadSidebar();
    loadMain(search.value.trim());
  }

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
    await Promise.all(
      ids.map(function (id) {
        return fetch("/api/conversations/" + encodeURIComponent(id), { method: "DELETE" }).catch(
          function () {},
        );
      }),
    );
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
      rows.appendChild(
        convRow(c, {
          dialogs: dialogs,
          reload: reloadAll,
          snippet: true,
          selectable: true,
          onCheck: updateDeleteBtn,
          onClick: function (c, ref) {
            if (selectMode) {
              ref.checkbox.checked = !ref.checkbox.checked;
              updateDeleteBtn();
            } else window.location.href = "/c/" + encodeURIComponent(c.id);
          },
          extra: function (_c, ref) {
            return [
              {
                label: "Select",
                onClick: function () {
                  if (!selectMode) setSelectMode(true);
                  ref.checkbox.checked = true;
                  updateDeleteBtn();
                },
              },
            ];
          },
        }),
      );
    });
  }

  async function loadSidebar() {
    try {
      var r = await fetch("/api/conversations");
      conversations = (await r.json()).conversations || [];
      writeListCache(conversations);
    } catch (_) {
      conversations = [];
    }
    sidebar.render(conversations);
  }
  async function loadMain(q) {
    if (!q) {
      renderRows(conversations, "");
      return;
    }
    var mine = ++searchSeq;
    try {
      var r = await fetch("/api/conversations?q=" + encodeURIComponent(q));
      var list = (await r.json()).conversations || [];
      if (mine === searchSeq) renderRows(list, q);
    } catch (_) {
      if (mine === searchSeq)
        rows.innerHTML = '<div class="chatsempty">Failed to load conversations</div>';
    }
  }

  selectBtn.addEventListener("click", function () {
    setSelectMode(!selectMode);
  });
  selectAllBtn.addEventListener("click", function () {
    var check = !allChecked();
    checks().forEach(function (c) {
      c.checked = check;
    });
    updateDeleteBtn();
  });
  deleteBtn.addEventListener("click", function () {
    deleteIds(selectedIds());
  });
  function syncClear() {
    clearSearch.hidden = search.value.length === 0;
  }
  search.addEventListener("input", function () {
    syncClear();
    clearTimeout(searchTimer);
    var q = search.value.trim();
    searchTimer = setTimeout(function () {
      loadMain(q);
    }, 160);
  });
  clearSearch.addEventListener("click", function () {
    search.value = "";
    syncClear();
    search.focus();
    loadMain("");
  });

  (async function () {
    var sidebarLoaded = loadSidebar(); // fire in parallel with the auth check
    // Paint cached rows immediately so the list isn't blank while the fetch and
    // auth check round-trip; the refresh below overwrites once loadSidebar lands.
    var cached = readListCache();
    if (cached && cached.length) {
      conversations = cached;
      loadMain("");
    }
    var me = await requireAuth();
    if (!me) return; // redirecting to login
    setPfp(me);
    await sidebarLoaded;
    loadMain("");
    search.focus();
  })();
})();
