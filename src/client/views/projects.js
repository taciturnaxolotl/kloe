/*
 * Projects gallery, as a router view. A grid of project cards (name, description,
 * last-active), a "New project" action, and click-through to /p/<id>. Mounted into
 * the shell's #viewOutlet by router.js — the sidebar, dialogs, and auth are already
 * up (the shell owns them), so this view only renders its own main region.
 *
 * Converted from the standalone projects.js: markup is client-owned (rendered into
 * `root` here rather than shipped as a separate HTML document), DOM lookups are
 * scoped to `root`, navigation goes through ctx.navigate (soft), and in-flight
 * fetches are abandoned on destroy.
 */

// The view's main region. IDs are looked up scoped to `root`, so the chat view's
// hidden-but-present #menu never collides with this one.
var TEMPLATE =
  '<header class="head chatshead">' +
  '<button class="icon menu" data-menu type="button" aria-label="Toggle sidebar" title="Toggle sidebar">' +
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>' +
  "</button>" +
  '<span class="title">Projects</span>' +
  '<div class="chatsactions"><button class="btn primary" data-new type="button">New project</button></div>' +
  "</header>" +
  '<div class="chatscroll"><div class="projpage">' +
  '<div class="projgrid" data-grid><div class="chatsempty">Loading…</div></div>' +
  "</div></div>";

var LIST_CACHE = "kloe:projects";
function readCache() {
  try {
    return JSON.parse(sessionStorage.getItem(LIST_CACHE) || "null");
  } catch (_) {
    return null;
  }
}
function writeCache(list) {
  try {
    sessionStorage.setItem(LIST_CACHE, JSON.stringify(list || []));
  } catch (_) {}
}

function fmtDate(ms) {
  var d = new Date(ms),
    now = new Date();
  var startOfDay = function (x) {
    return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  };
  var days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  var opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

export function mount(root, _params, ctx) {
  root.innerHTML = TEMPLATE;
  var grid = root.querySelector("[data-grid]");
  var abort = new AbortController();

  root.querySelector("[data-menu]").addEventListener("click", function () {
    ctx.toggleRail();
  });

  function render(list) {
    grid.innerHTML = "";
    if (!list.length) {
      grid.innerHTML =
        '<div class="chatsempty">No projects yet. Create one to group chats and pin shared memory.</div>';
      return;
    }
    list.forEach(function (p) {
      var card = document.createElement("a");
      card.className = "projcard";
      card.href = "/p/" + encodeURIComponent(p.id);
      var name = document.createElement("div");
      name.className = "projcardname";
      name.textContent = p.name;
      card.appendChild(name);
      if (p.description) {
        var d = document.createElement("div");
        d.className = "projcarddesc";
        d.textContent = p.description;
        card.appendChild(d);
      }
      var meta = document.createElement("div");
      meta.className = "projcardmeta";
      var count = p.chatCount ? " · " + p.chatCount + " chat" + (p.chatCount > 1 ? "s" : "") : "";
      meta.textContent = fmtDate(p.updatedAt) + count;
      card.appendChild(meta);
      grid.appendChild(card);
    });
  }

  async function load() {
    try {
      var res = await fetch("/api/projects", { signal: abort.signal });
      var list = (await res.json()).projects || [];
      render(list);
      writeCache(list);
    } catch (_) {
      if (abort.signal.aborted) return; // navigated away — leave the DOM alone
      if (!grid.children.length)
        grid.innerHTML = '<div class="chatsempty">Failed to load projects</div>';
    }
  }

  root.querySelector("[data-new]").addEventListener("click", async function () {
    var name = await ctx.dialogs.prompt({
      title: "New project",
      placeholder: "Project name",
      ok: "Create",
    });
    if (!name || !name.trim()) return;
    try {
      var r = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      var j = await r.json();
      if (j.id) ctx.navigate("/p/" + encodeURIComponent(j.id));
    } catch (_) {
      /* stay put on failure */
    }
  });

  // Paint cached cards immediately (instant view swap), then revalidate.
  var cached = readCache();
  if (cached && cached.length) render(cached);
  load();

  return {
    destroy: function () {
      abort.abort();
    },
  };
}
