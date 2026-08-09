/*
 * Conversations page, as a router view. Always-open search over titles AND
 * message contents (GET /api/conversations?q=), a per-row ⋮ menu, and a bulk
 * select/delete mode. Mounted into the shell's #viewOutlet — the sidebar, dialogs,
 * and auth are already up, so this view renders only its main region and routes
 * navigation through ctx.
 *
 * Converted from the standalone conversations.js: client-owned markup, DOM lookups
 * scoped to `root` via data-* hooks (so the hidden chat shell's ids never
 * collide), soft-nav via ctx.navigate, and a destroy() that clears the search
 * timer and the global `selecting` body class.
 */
import { convRow } from "../convrow.js";

var MENU_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>';
var SEARCH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
var CLEAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

var TEMPLATE =
  '<header class="head chatshead">' +
  '<button class="icon menu" data-menu type="button" aria-label="Toggle sidebar" title="Toggle sidebar">' +
  MENU_SVG +
  "</button>" +
  '<span class="title">Conversations</span>' +
  '<div class="chatsactions">' +
  '<span class="selcount" data-selcount>0 selected</span>' +
  '<div class="chatsearch">' +
  SEARCH_SVG +
  '<input data-search type="search" placeholder="Search conversations…" autocomplete="off" spellcheck="false" aria-label="Search conversations">' +
  '<button class="clearsearch" data-clearsearch type="button" hidden aria-label="Clear search">' +
  CLEAR_SVG +
  "</button>" +
  "</div>" +
  '<button class="btn" data-selectbtn type="button">Select</button>' +
  '<button class="btn" data-selectall type="button">Select all</button>' +
  '<button class="btn danger" data-deletebtn type="button" hidden>Delete</button>' +
  '<a class="btn primary" data-newbtn href="/?new=1">New</a>' +
  "</div>" +
  "</header>" +
  '<div class="chatscroll"><div class="chatspage">' +
  '<div class="chatrows" data-rows><div class="chatsempty">Loading…</div></div>' +
  "</div></div>";

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

export function mount(root, _params, ctx) {
  root.innerHTML = TEMPLATE;
  var q = function (sel) {
    return root.querySelector(sel);
  };
  var rows = q("[data-rows]"),
    search = q("[data-search]"),
    clearSearch = q("[data-clearsearch]");
  var selectBtn = q("[data-selectbtn]"),
    deleteBtn = q("[data-deletebtn]"),
    selCount = q("[data-selcount]"),
    selectAllBtn = q("[data-selectall]");

  var conversations = []; // full list (for the sidebar recents + unfiltered rows)
  var selectMode = false;
  var searchTimer = null,
    searchSeq = 0;

  q("[data-menu]").addEventListener("click", function () {
    ctx.toggleRail();
  });

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
    var ok = await ctx.dialogs.confirm({
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

  function renderRows(list, query) {
    rows.innerHTML = "";
    if (!list.length) {
      var e = document.createElement("div");
      e.className = "chatsempty";
      e.textContent = query ? "No conversations match “" + query + "”" : "No conversations yet";
      rows.appendChild(e);
      return;
    }
    list.forEach(function (c) {
      rows.appendChild(
        convRow(c, {
          dialogs: ctx.dialogs,
          reload: reloadAll,
          snippet: true,
          selectable: true,
          onCheck: updateDeleteBtn,
          onClick: function (c, ref) {
            if (selectMode) {
              ref.checkbox.checked = !ref.checkbox.checked;
              updateDeleteBtn();
            } else ctx.navigate("/c/" + encodeURIComponent(c.id));
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
    ctx.sidebar.render(conversations);
  }
  async function loadMain(query) {
    if (!query) {
      renderRows(conversations, "");
      return;
    }
    var mine = ++searchSeq;
    try {
      var r = await fetch("/api/conversations?q=" + encodeURIComponent(query));
      var list = (await r.json()).conversations || [];
      if (mine === searchSeq) renderRows(list, query);
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
    var query = search.value.trim();
    searchTimer = setTimeout(function () {
      loadMain(query);
    }, 160);
  });
  clearSearch.addEventListener("click", function () {
    search.value = "";
    syncClear();
    search.focus();
    loadMain("");
  });

  // Paint cached rows immediately, then revalidate; the sidebar refresh overwrites
  // once /api/conversations lands.
  var sidebarLoaded = loadSidebar();
  var cached = readListCache();
  if (cached && cached.length) {
    conversations = cached;
    loadMain("");
  }
  sidebarLoaded.then(function () {
    loadMain("");
  });
  search.focus();

  return {
    destroy: function () {
      clearTimeout(searchTimer);
      searchSeq++; // invalidate any in-flight search render
      document.body.classList.remove("selecting");
    },
  };
}
