/*
 * The Projects gallery: a grid of project cards (name, description, last-active),
 * a "New project" action, and click-through to /p/<id>. Shares the app sidebar.
 */
import { mountSidebar } from "./sidebar.js";
import { mountDialogs } from "./confirm.js";
import { requireAuth, setPfp } from "./authguard.js";

(function () {
  "use strict";
  var grid = document.getElementById("grid");
  var dialogs = mountDialogs();

  var sidebar = mountSidebar({
    onSelect: function (id) { window.location.href = "/c/" + encodeURIComponent(id); },
    onNew: function () { window.location.href = "/?new=1"; },
    dialogs: dialogs,
    reload: loadSidebar,
  });

  // The list survives a navigation in sessionStorage so the grid paints
  // instantly on the next visit; the fetch below revalidates.
  var LIST_CACHE = "kloe:projects";
  function readCache() {
    try { return JSON.parse(sessionStorage.getItem(LIST_CACHE) || "null"); } catch (_) { return null; }
  }
  function writeCache(list) {
    try { sessionStorage.setItem(LIST_CACHE, JSON.stringify(list || [])); } catch (_) {}
  }

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

  function render(list) {
    grid.innerHTML = "";
    if (!list.length) {
      grid.innerHTML = '<div class="chatsempty">No projects yet. Create one to group chats and pin shared memory.</div>';
      return;
    }
    list.forEach(function (p) {
      var card = document.createElement("a");
      card.className = "projcard";
      card.href = "/p/" + encodeURIComponent(p.id);
      var name = document.createElement("div");
      name.className = "projcardname"; name.textContent = p.name;
      card.appendChild(name);
      if (p.description) {
        var d = document.createElement("div");
        d.className = "projcarddesc"; d.textContent = p.description;
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
      var list = (await (await fetch("/api/projects")).json()).projects || [];
      render(list); writeCache(list);
    } catch (_) {
      if (!grid.children.length) grid.innerHTML = '<div class="chatsempty">Failed to load projects</div>';
    }
  }

  async function loadSidebar() {
    try {
      var conversations = ((await (await fetch("/api/conversations")).json()).conversations) || [];
      sidebar.render(conversations);
    } catch (_) { sidebar.render([]); }
  }

  document.getElementById("newProject").addEventListener("click", async function () {
    var name = await dialogs.prompt({ title: "New project", placeholder: "Project name", ok: "Create" });
    if (!name || !name.trim()) return;
    try {
      var r = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      var j = await r.json();
      if (j.id) window.location.href = "/p/" + encodeURIComponent(j.id);
    } catch (_) { /* stay put on failure */ }
  });

  (async function () {
    // Fire the data fetches immediately, in parallel with the auth check, and
    // paint cached cards right away so the grid isn't blank across the round
    // trips. On a 401 requireAuth navigates away and the fetches are abandoned.
    var loaded = load();
    loadSidebar();
    var cached = readCache();
    if (cached && cached.length) render(cached);
    var me = await requireAuth();
    if (!me) return;
    setPfp(me);
    await loaded;
  })();
})();
