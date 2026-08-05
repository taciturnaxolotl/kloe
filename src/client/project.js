/*
 * Project detail (/p/<id>): editable name + description, the project's chats with
 * a "new chat in this project" action, and a Memory panel to pin a lard project
 * and browse its subjects. Shares the app sidebar.
 */
import { mountSidebar } from "./sidebar.js";
import { mountDialogs } from "./confirm.js";
import { requireAuth, setPfp } from "./authguard.js";

(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var dialogs = mountDialogs();
  var projectId = (location.pathname.match(/^\/p\/([^/]+)/) || [])[1];
  projectId = projectId ? decodeURIComponent(projectId) : null;

  var sidebar = mountSidebar({
    onSelect: function (id) { window.location.href = "/c/" + encodeURIComponent(id); },
    onNew: function () { window.location.href = "/?new=1"; },
    dialogs: dialogs,
    reload: loadSidebar,
  });

  function fmtDate(ms) {
    var d = new Date(ms), now = new Date();
    var sod = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var days = Math.round((sod(now) - sod(d)) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    var o = { month: "short", day: "numeric" };
    if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
    return d.toLocaleDateString(undefined, o);
  }

  var CHAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/></svg>';

  function renderChats(list) {
    var rows = $("rows");
    rows.innerHTML = "";
    if (!list.length) { rows.innerHTML = '<div class="chatsempty">No chats yet. Start one below.</div>'; return; }
    list.forEach(function (c) {
      var row = document.createElement("a");
      row.className = "chatrow"; row.href = "/c/" + encodeURIComponent(c.id);
      var icon = document.createElement("span"); icon.className = "chaticon"; icon.innerHTML = CHAT_ICON;
      var main = document.createElement("div"); main.className = "chatmain";
      var t = document.createElement("div"); t.className = "chattitle"; t.textContent = c.title || "Untitled";
      main.appendChild(t);
      var end = document.createElement("div"); end.className = "chatend";
      var date = document.createElement("div"); date.className = "chatdate"; date.textContent = fmtDate(c.updatedAt || c.createdAt);
      end.appendChild(date);
      row.appendChild(icon); row.appendChild(main); row.appendChild(end);
      rows.appendChild(row);
    });
  }

  // Save a field on change; the server PATCHes name/description/lardProject.
  async function patch(fields) {
    try { await fetch("/api/projects/" + encodeURIComponent(projectId), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(fields) }); }
    catch (_) { /* leave as-is */ }
  }

  async function loadSubjects() {
    var el = $("subjects");
    try {
      var r = await fetch("/api/lard/memory");
      if (!r.ok) { el.innerHTML = ""; return; } // not connected → nothing to show
      var items = (await r.json()).listing || [];
      el.innerHTML = "";
      items.forEach(function (s) {
        var b = document.createElement("div");
        b.className = "lardsubject";
        var n = document.createElement("span"); n.className = "ln"; n.textContent = s.name || s.path;
        b.appendChild(n);
        if (s.description) { var d = document.createElement("span"); d.className = "ld"; d.textContent = s.description; b.appendChild(d); }
        el.appendChild(b);
      });
    } catch (_) { el.innerHTML = ""; }
  }

  async function load() {
    var res;
    try { res = await fetch("/api/projects/" + encodeURIComponent(projectId)); }
    catch (_) { document.querySelector(".main .title").textContent = "Failed to load"; return; }
    if (!res.ok) { window.location.href = "/projects"; return; }
    var data = await res.json();
    var p = data.project;
    document.title = p.name + " · Kloe";
    $("crumbname").textContent = p.name;
    $("pname").value = p.name;
    $("pdesc").value = p.description || "";
    $("pinInput").value = p.lardProject || "";
    $("deleteProject").hidden = false;
    $("detail").hidden = false;
    renderChats(data.conversations || []);
    loadSubjects();
  }

  $("pname").addEventListener("change", function () {
    var v = this.value.trim();
    if (v) { patch({ name: v }); $("crumbname").textContent = v; }
  });
  $("pdesc").addEventListener("change", function () { patch({ description: this.value }); });
  $("pinSave").addEventListener("click", function () { patch({ lardProject: $("pinInput").value.trim() }); });
  $("newChat").addEventListener("click", function () {
    window.location.href = "/?project=" + encodeURIComponent(projectId);
  });
  $("deleteProject").addEventListener("click", async function () {
    var ok = await dialogs.confirm({ title: "Delete project?", body: "Its chats stay but become unfiled. This can't be undone.", ok: "Delete", danger: true });
    if (!ok) return;
    try { await fetch("/api/projects/" + encodeURIComponent(projectId), { method: "DELETE" }); } catch (_) {}
    window.location.href = "/projects";
  });

  async function loadSidebar() {
    try { sidebar.render(((await (await fetch("/api/conversations")).json()).conversations) || []); }
    catch (_) { sidebar.render([]); }
  }

  (async function () {
    if (!projectId) { window.location.href = "/projects"; return; }
    var me = await requireAuth();
    if (!me) return;
    setPfp(me);
    loadSidebar();
    load();
  })();
})();
