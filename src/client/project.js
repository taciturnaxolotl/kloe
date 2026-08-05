/*
 * Project detail (/p/<id>): name + description (edited via the ⋮ → details
 * modal, not inline), the project's chats with a "new chat" action, and a side
 * panel — Memory (the pinned lard project + a content preview) and Context
 * (uploaded files injected into the project's chats). Shares the app sidebar.
 */
import { mountSidebar } from "./sidebar.js";
import { mountDialogs } from "./confirm.js";
import { showContextMenu } from "./ctxmenu.js";
import { requireAuth, setPfp } from "./authguard.js";
import { CONV_ICON, MORE_ICON, PENCIL_ICON, PLUS_ICON, TRASH_ICON, FILE_ICON } from "./icons.js";

(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var dialogs = mountDialogs();
  var projectId = (location.pathname.match(/^\/p\/([^/]+)/) || [])[1];
  projectId = projectId ? decodeURIComponent(projectId) : null;
  var project = null;

  var sidebar = mountSidebar({
    onSelect: function (id) { window.location.href = "/c/" + encodeURIComponent(id); },
    onNew: function () { window.location.href = "/?new=1"; },
    dialogs: dialogs,
    reload: loadSidebar,
  });

  // Icons from the shared set (no inline SVG).
  $("projMenu").innerHTML = MORE_ICON;
  $("memEdit").innerHTML = PENCIL_ICON;
  $("ctxAdd").innerHTML = PLUS_ICON;

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

  // ---- chats ----
  function renderChats(list) {
    var rows = $("rows");
    rows.innerHTML = "";
    if (!list.length) { rows.innerHTML = '<div class="chatsempty">No chats yet. Start one below.</div>'; return; }
    list.forEach(function (c) {
      var row = document.createElement("a");
      row.className = "chatrow"; row.href = "/c/" + encodeURIComponent(c.id);
      var icon = document.createElement("span"); icon.className = "chaticon"; icon.innerHTML = CONV_ICON;
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

  async function patch(fields) {
    try {
      await fetch("/api/projects/" + encodeURIComponent(projectId), {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(fields),
      });
    } catch (_) { /* leave as-is */ }
  }

  // ---- memory panel ----
  async function renderMemory() {
    var el = $("memBody");
    var pin = project.lardProject;
    if (!pin) {
      el.innerHTML = '<p class="lardhint">No memory pinned. Pin a lard project so this project’s chats read and record durable context.</p>';
      return;
    }
    el.innerHTML = '<div class="pinname"></div><p class="lardhint">Loading…</p>';
    el.querySelector(".pinname").textContent = pin;
    try {
      var r = await fetch("/api/lard/context?project=" + encodeURIComponent(pin));
      if (!r.ok) { el.querySelector(".lardhint").textContent = r.status === 409 ? "Connect lard in Settings to view its memory." : "Couldn’t load memory."; return; }
      var ctx = await r.json();
      var preview = (ctx.area || ctx.profile || "").trim();
      el.querySelector(".lardhint").textContent = preview ? preview.slice(0, 240) + (preview.length > 240 ? "…" : "") : "No memory recorded yet.";
    } catch (_) { el.querySelector(".lardhint").textContent = "Couldn’t load memory."; }
  }

  // ---- pin-project picker (searchable list of lard projects) ----
  var pinProjects = null; // cached list from /api/lard/projects

  async function pinTo(id) {
    await patch({ lardProject: id });
    project.lardProject = id;
    closePin();
    renderMemory();
  }

  function renderPinList() {
    var list = $("pinList");
    var q = $("pinSearch").value.trim().toLowerCase();
    if (pinProjects === null) { list.innerHTML = '<p class="lardhint">Loading…</p>'; return; }
    if (pinProjects === false) { list.innerHTML = '<p class="lardhint">Connect lard in Settings to pick a project.</p>'; return; }
    var items = pinProjects.filter(function (p) {
      if (!q) return true;
      return (p.id + " " + (p.displayName || "")).toLowerCase().indexOf(q) !== -1;
    });
    if (!items.length) { list.innerHTML = '<p class="lardhint">No matching projects.</p>'; return; }
    list.innerHTML = "";
    items.forEach(function (p) {
      var row = document.createElement("button");
      row.className = "pinrow" + (p.id === project.lardProject ? " active" : "");
      row.type = "button";
      var name = document.createElement("span"); name.className = "pinrowname"; name.textContent = p.displayName || p.id;
      row.appendChild(name);
      if (p.displayName && p.displayName !== p.id) {
        var id = document.createElement("span"); id.className = "pinrowid"; id.textContent = p.id;
        row.appendChild(id);
      }
      row.addEventListener("click", function () { pinTo(p.id); });
      list.appendChild(row);
    });
  }

  function closePin() { $("pinModal").hidden = true; }
  $("pinBack").addEventListener("click", closePin);
  $("pinCancel").addEventListener("click", closePin);
  $("pinUnpin").addEventListener("click", function () { pinTo(""); });
  $("pinSearch").addEventListener("input", renderPinList);

  $("memEdit").addEventListener("click", async function () {
    $("pinSearch").value = "";
    $("pinModal").hidden = false;
    $("pinSearch").focus();
    renderPinList();
    if (pinProjects === null) {
      try {
        var r = await fetch("/api/lard/projects");
        pinProjects = r.ok ? ((await r.json()).projects || []) : false;
      } catch (_) { pinProjects = false; }
      renderPinList();
    }
  });

  // ---- context files ----
  var TYPE = { md: "MD", markdown: "MD", txt: "TXT", text: "TXT", json: "JSON", csv: "CSV", yaml: "YAML", yml: "YAML" };
  async function renderContext() {
    var el = $("ctxBody");
    var files;
    try { files = (await (await fetch("/api/projects/" + encodeURIComponent(projectId) + "/context")).json()).files || []; }
    catch (_) { el.innerHTML = '<p class="lardhint">Couldn’t load context files.</p>'; return; }
    el.innerHTML = "";
    if (!files.length) { el.innerHTML = '<p class="lardhint">Add text files to give every chat in this project shared context.</p>'; return; }
    files.forEach(function (f) {
      var card = document.createElement("div");
      card.className = "ctxcard";
      var name = document.createElement("div"); name.className = "ctxname"; name.textContent = f.filename;
      var meta = document.createElement("div"); meta.className = "ctxmeta"; meta.textContent = f.lines + " line" + (f.lines === 1 ? "" : "s");
      var ext = (f.filename.split(".").pop() || "").toLowerCase();
      var badge = document.createElement("span"); badge.className = "ctxbadge"; badge.textContent = TYPE[ext] || ext.toUpperCase().slice(0, 4) || "FILE";
      var del = document.createElement("button"); del.className = "ctxdel"; del.type = "button"; del.setAttribute("aria-label", "Remove"); del.innerHTML = TRASH_ICON;
      del.addEventListener("click", async function (e) {
        e.stopPropagation();
        await fetch("/api/projects/" + encodeURIComponent(projectId) + "/context/" + encodeURIComponent(f.id), { method: "DELETE" }).catch(function () {});
        renderContext();
      });
      card.appendChild(name); card.appendChild(meta); card.appendChild(badge); card.appendChild(del);
      el.appendChild(card);
    });
  }

  $("ctxAdd").addEventListener("click", function () { $("fileInput").click(); });
  $("fileInput").addEventListener("change", async function () {
    var file = this.files && this.files[0];
    this.value = "";
    if (!file) return;
    var text = await file.text();
    try {
      await fetch("/api/projects/" + encodeURIComponent(projectId) + "/context?name=" + encodeURIComponent(file.name), {
        method: "POST", headers: { "content-type": "text/plain" }, body: text,
      });
      renderContext();
    } catch (_) { /* ignore */ }
  });

  // ---- details modal (name + description) ----
  function openDetails() {
    $("mName").value = project.name;
    $("mDesc").value = project.description || "";
    $("detailsModal").hidden = false;
    $("mName").focus();
  }
  function closeDetails() { $("detailsModal").hidden = true; }
  $("detailsBack").addEventListener("click", closeDetails);
  $("mCancel").addEventListener("click", closeDetails);
  $("mSave").addEventListener("click", async function () {
    var name = $("mName").value.trim();
    if (!name) { $("mName").focus(); return; }
    var desc = $("mDesc").value;
    await patch({ name: name, description: desc });
    project.name = name; project.description = desc;
    $("pname").textContent = name; $("crumbname").textContent = name;
    $("pdesc").textContent = desc; $("pdesc").hidden = !desc;
    document.title = name + " · Kloe";
    closeDetails();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!$("detailsModal").hidden) closeDetails();
    if (!$("pinModal").hidden) closePin();
  });

  // ---- ⋮ project menu ----
  $("projMenu").addEventListener("click", function (e) {
    e.stopPropagation(); // else this same click bubbles to the ctxmenu's outside-click close
    var r = this.getBoundingClientRect();
    showContextMenu(r.right, r.bottom + 4, [
      { label: "Edit details", icon: PENCIL_ICON, onClick: openDetails },
      { label: "Delete project", icon: TRASH_ICON, danger: true, onClick: async function () {
        var ok = await dialogs.confirm({ title: "Delete project?", body: "Its chats stay but become unfiled. This can’t be undone.", ok: "Delete", danger: true });
        if (!ok) return;
        await fetch("/api/projects/" + encodeURIComponent(projectId), { method: "DELETE" }).catch(function () {});
        window.location.href = "/projects";
      } },
    ]);
  });

  $("newChat").addEventListener("click", function () { window.location.href = "/?new=1&project=" + encodeURIComponent(projectId); });

  async function loadSidebar() {
    try { sidebar.render(((await (await fetch("/api/conversations")).json()).conversations) || []); }
    catch (_) { sidebar.render([]); }
  }

  async function load() {
    var res;
    try { res = await fetch("/api/projects/" + encodeURIComponent(projectId)); }
    catch (_) { return; }
    if (!res.ok) { window.location.href = "/projects"; return; }
    var data = await res.json();
    project = data.project;
    document.title = project.name + " · Kloe";
    $("crumbname").textContent = project.name;
    $("pname").textContent = project.name;
    $("pdesc").textContent = project.description || ""; $("pdesc").hidden = !project.description;
    $("detail").hidden = false;
    renderChats(data.conversations || []);
    renderMemory();
    renderContext();
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
