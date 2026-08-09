/*
 * Project detail (/p/<id>), as a router view. Name + description (edited via ⋮ →
 * details modal), the project's chats with a "new chat" action, and a side panel:
 * Memory (the pinned lard project + preview) and Context (uploaded files injected
 * into the project's chats). Mounted into the shell's #viewOutlet.
 *
 * Converted from the standalone project.js: client-owned markup (including the
 * modals + hidden file input, which were body-level and now live inside the view
 * root so they're torn down with it), DOM lookups scoped to `root`, navigation via
 * ctx, and a destroy() that removes the document-level Escape handler.
 */
import { convRow } from "../convrow.js";
import { showContextMenu } from "../ctxmenu.js";
import { MORE_ICON, PENCIL_ICON, PLUS_ICON, TRASH_ICON } from "../icons.js";

var MENU_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>';

var TEMPLATE =
  '<header class="head">' +
  '<button class="icon menu" id="menu" type="button" aria-label="Toggle sidebar" title="Toggle sidebar">' +
  MENU_SVG +
  "</button>" +
  '<nav class="crumbs"><a href="/projects">Projects</a><span class="crumbsep">/</span><span id="crumbname" class="title">…</span></nav>' +
  '<div class="chatsactions"><button class="icon" id="projMenu" type="button" aria-label="Project options" title="Project options"></button></div>' +
  "</header>" +
  '<div class="chatscroll"><div class="projdetail" id="detail" hidden>' +
  '<div class="projcol">' +
  '<h1 class="projtitle" id="pname">…</h1>' +
  '<p class="projsub" id="pdesc"></p>' +
  '<button class="btn primary projnew" id="newChat" type="button">New chat in this project</button>' +
  '<div class="raillabel">Chats</div>' +
  '<div class="chatrows" id="rows"><div class="chatsempty">No chats yet.</div></div>' +
  "</div>" +
  '<aside class="projaside">' +
  '<section class="projpanel"><div class="panelhead"><span>Memory</span><button class="panelbtn" id="memEdit" type="button" aria-label="Change pinned project"></button></div><div class="panelbody" id="memBody"></div></section>' +
  '<section class="projpanel"><div class="panelhead"><span>Context</span><button class="panelbtn" id="ctxAdd" type="button" aria-label="Add a context file"></button></div><div class="panelbody" id="ctxBody"></div></section>' +
  "</aside>" +
  "</div></div>" +
  '<input type="file" id="fileInput" accept=".md,.markdown,.txt,.text,.json,.csv,.yaml,.yml,text/*" hidden>' +
  '<div class="modal" id="detailsModal" hidden><div class="modalback" id="detailsBack"></div><div class="modalcard">' +
  '<div class="modalh">Project details</div>' +
  '<label class="modallabel" for="mName">Name</label><input class="modalinput" id="mName" maxlength="120">' +
  '<label class="modallabel" for="mDesc">Description</label><textarea class="modaltext" id="mDesc" rows="3" maxlength="2000" placeholder="What is this project about?"></textarea>' +
  '<div class="modalbtns"><button class="btn" id="mCancel" type="button">Cancel</button><button class="btn primary" id="mSave" type="button">Save</button></div>' +
  "</div></div>" +
  '<div class="modal" id="pinModal" hidden><div class="modalback" id="pinBack"></div><div class="modalcard">' +
  '<div class="modalh">Pin lard project</div>' +
  '<input class="modalinput" id="pinSearch" placeholder="Search projects…" autocomplete="off">' +
  '<div class="pinlist" id="pinList"></div>' +
  '<div class="modalbtns"><button class="btn" id="pinUnpin" type="button" style="margin-right:auto">Unpin</button><button class="btn" id="pinCancel" type="button">Cancel</button></div>' +
  "</div></div>";

var TYPE = {
  md: "MD",
  markdown: "MD",
  txt: "TXT",
  text: "TXT",
  json: "JSON",
  csv: "CSV",
  yaml: "YAML",
  yml: "YAML",
};
var BINARY_EXT =
  /\.(xlsx?|xlsm|ods|docx?|pptx?|pdf|png|jpe?g|gif|webp|bmp|tiff?|ico|svg|heic|zip|gz|tar|rar|7z|bz2|xz|mp3|wav|flac|ogg|mp4|mov|avi|mkv|webm|exe|dll|so|dylib|bin|wasm|class|ttf|otf|woff2?|sqlite|db)$/i;
function isTextFile(f) {
  if (BINARY_EXT.test(f.name)) return false;
  if (f.type && !/^text\//.test(f.type)) {
    return (
      /^application\/(json|xml|x-yaml|yaml|toml|x-sh|javascript|csv)$|^$/.test(f.type) ||
      /\+xml$|\+json$/.test(f.type)
    );
  }
  return true;
}

export function mount(root, params, ctx) {
  root.innerHTML = TEMPLATE;
  var $ = function (sel) {
    return root.querySelector(sel);
  };
  var projectId = params.id;
  var project = null;
  var pinProjects = null; // cached list from /api/lard/projects

  if (!projectId) {
    ctx.navigate("/projects");
    return {};
  }

  $("#menu").addEventListener("click", function () {
    ctx.toggleRail();
  });

  // Icons from the shared set (no inline SVG).
  $("#projMenu").innerHTML = MORE_ICON;
  $("#memEdit").innerHTML = PENCIL_ICON;
  $("#ctxAdd").innerHTML = PLUS_ICON;

  // ---- chats ----
  function renderChats(list) {
    var rows = $("#rows");
    rows.innerHTML = "";
    if (!list.length) {
      rows.innerHTML = '<div class="chatsempty">No chats yet. Start one below.</div>';
      return;
    }
    list.forEach(function (c) {
      rows.appendChild(convRow(c, { dialogs: ctx.dialogs, reload: loadChats }));
    });
  }
  async function loadChats() {
    try {
      var d = await (await fetch("/api/projects/" + encodeURIComponent(projectId))).json();
      renderChats(d.conversations || []);
    } catch (_) {
      /* leave the current rows */
    }
  }
  async function patch(fields) {
    try {
      await fetch("/api/projects/" + encodeURIComponent(projectId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fields),
      });
    } catch (_) {
      /* leave as-is */
    }
  }

  // ---- memory panel ----
  async function renderMemory() {
    var el = $("#memBody");
    var pin = project.lardProject;
    if (!pin) {
      el.innerHTML =
        '<p class="lardhint">No memory pinned. Pin a lard project so this project’s chats read and record durable context.</p>';
      return;
    }
    el.innerHTML = '<div class="pinname"></div><p class="lardhint">Loading…</p>';
    el.querySelector(".pinname").textContent = pin;
    try {
      var r = await fetch("/api/lard/context?project=" + encodeURIComponent(pin));
      if (!r.ok) {
        el.querySelector(".lardhint").textContent =
          r.status === 409
            ? "Connect lard in Settings to view its memory."
            : "Couldn’t load memory.";
        return;
      }
      var data = await r.json();
      var preview = (data.area || data.profile || "").trim();
      el.querySelector(".lardhint").textContent = preview
        ? preview.slice(0, 240) + (preview.length > 240 ? "…" : "")
        : "No memory recorded yet.";
    } catch (_) {
      el.querySelector(".lardhint").textContent = "Couldn’t load memory.";
    }
  }

  // ---- pin-project picker ----
  async function pinTo(id) {
    await patch({ lardProject: id });
    project.lardProject = id;
    closePin();
    renderMemory();
  }
  function renderPinList() {
    var list = $("#pinList");
    var q = $("#pinSearch").value.trim().toLowerCase();
    if (pinProjects === null) {
      list.innerHTML = '<p class="lardhint">Loading…</p>';
      return;
    }
    if (pinProjects === false) {
      list.innerHTML = '<p class="lardhint">Connect lard in Settings to pick a project.</p>';
      return;
    }
    var items = pinProjects.filter(function (p) {
      if (!q) return true;
      return (p.id + " " + (p.displayName || "")).toLowerCase().indexOf(q) !== -1;
    });
    if (!items.length) {
      list.innerHTML = '<p class="lardhint">No matching projects.</p>';
      return;
    }
    list.innerHTML = "";
    items.forEach(function (p) {
      var row = document.createElement("button");
      row.className = "pinrow" + (p.id === project.lardProject ? " active" : "");
      row.type = "button";
      var name = document.createElement("span");
      name.className = "pinrowname";
      name.textContent = p.displayName || p.id;
      row.appendChild(name);
      if (p.displayName && p.displayName !== p.id) {
        var id = document.createElement("span");
        id.className = "pinrowid";
        id.textContent = p.id;
        row.appendChild(id);
      }
      row.addEventListener("click", function () {
        pinTo(p.id);
      });
      list.appendChild(row);
    });
  }
  function closePin() {
    $("#pinModal").hidden = true;
  }
  $("#pinBack").addEventListener("click", closePin);
  $("#pinCancel").addEventListener("click", closePin);
  $("#pinUnpin").addEventListener("click", function () {
    pinTo("");
  });
  $("#pinSearch").addEventListener("input", renderPinList);
  $("#memEdit").addEventListener("click", async function () {
    $("#pinSearch").value = "";
    $("#pinModal").hidden = false;
    $("#pinSearch").focus();
    renderPinList();
    if (pinProjects === null) {
      try {
        var r = await fetch("/api/lard/projects");
        pinProjects = r.ok ? (await r.json()).projects || [] : false;
      } catch (_) {
        pinProjects = false;
      }
      renderPinList();
    }
  });

  // ---- context files ----
  async function renderContext() {
    var el = $("#ctxBody");
    var files;
    try {
      files =
        (await (await fetch("/api/projects/" + encodeURIComponent(projectId) + "/context")).json())
          .files || [];
    } catch (_) {
      el.innerHTML = '<p class="lardhint">Couldn’t load context files.</p>';
      return;
    }
    el.innerHTML = "";
    if (!files.length) {
      el.innerHTML =
        '<p class="lardhint">Add text files to give every chat in this project shared context.</p>';
      return;
    }
    files.forEach(function (f) {
      var card = document.createElement("div");
      card.className = "ctxcard";
      var name = document.createElement("div");
      name.className = "ctxname";
      name.textContent = f.filename;
      var meta = document.createElement("div");
      meta.className = "ctxmeta";
      meta.textContent = f.lines + " line" + (f.lines === 1 ? "" : "s");
      var ext = (f.filename.split(".").pop() || "").toLowerCase();
      var badge = document.createElement("span");
      badge.className = "ctxbadge";
      badge.textContent = TYPE[ext] || ext.toUpperCase().slice(0, 4) || "FILE";
      var del = document.createElement("button");
      del.className = "ctxdel";
      del.type = "button";
      del.setAttribute("aria-label", "Remove");
      del.innerHTML = TRASH_ICON;
      del.addEventListener("click", async function (e) {
        e.stopPropagation();
        await fetch(
          "/api/projects/" + encodeURIComponent(projectId) + "/context/" + encodeURIComponent(f.id),
          { method: "DELETE" },
        ).catch(function () {});
        renderContext();
      });
      card.appendChild(name);
      card.appendChild(meta);
      card.appendChild(badge);
      card.appendChild(del);
      el.appendChild(card);
    });
  }
  $("#ctxAdd").addEventListener("click", function () {
    $("#fileInput").click();
  });
  $("#fileInput").addEventListener("change", async function () {
    var file = this.files && this.files[0];
    this.value = "";
    if (!file) return;
    if (!isTextFile(file)) {
      ctx.dialogs.confirm({
        title: "Only text files",
        body:
          "“" +
          file.name +
          "” isn’t a text file. Add plain-text notes, markdown, JSON, CSV, and the like — not spreadsheets, images, or other binary files.",
        ok: "OK",
      });
      return;
    }
    var text = await file.text();
    try {
      var r = await fetch(
        "/api/projects/" +
          encodeURIComponent(projectId) +
          "/context?name=" +
          encodeURIComponent(file.name),
        { method: "POST", headers: { "content-type": "text/plain" }, body: text },
      );
      if (!r.ok) {
        var err = await r.json().catch(function () {
          return {};
        });
        ctx.dialogs.confirm({
          title: "Couldn’t add file",
          body: err.error || "The file was rejected.",
          ok: "OK",
        });
        return;
      }
      renderContext();
    } catch (_) {
      /* ignore */
    }
  });

  // ---- details modal ----
  function openDetails() {
    $("#mName").value = project.name;
    $("#mDesc").value = project.description || "";
    $("#detailsModal").hidden = false;
    $("#mName").focus();
  }
  function closeDetails() {
    $("#detailsModal").hidden = true;
  }
  $("#detailsBack").addEventListener("click", closeDetails);
  $("#mCancel").addEventListener("click", closeDetails);
  $("#mSave").addEventListener("click", async function () {
    var name = $("#mName").value.trim();
    if (!name) {
      $("#mName").focus();
      return;
    }
    var desc = $("#mDesc").value;
    await patch({ name: name, description: desc });
    project.name = name;
    project.description = desc;
    $("#pname").textContent = name;
    $("#crumbname").textContent = name;
    $("#pdesc").textContent = desc;
    $("#pdesc").hidden = !desc;
    document.title = name + " · Kloe";
    closeDetails();
  });
  function onKeydown(e) {
    if (e.key !== "Escape") return;
    if (!$("#detailsModal").hidden) closeDetails();
    if (!$("#pinModal").hidden) closePin();
  }
  document.addEventListener("keydown", onKeydown);

  // ---- ⋮ project menu ----
  $("#projMenu").addEventListener("click", function (e) {
    e.stopPropagation();
    var r = this.getBoundingClientRect();
    showContextMenu(
      r.right,
      r.bottom + 4,
      [
        { label: "Edit details", icon: PENCIL_ICON, onClick: openDetails },
        {
          label: "Delete project",
          icon: TRASH_ICON,
          danger: true,
          onClick: async function () {
            var ok = await ctx.dialogs.confirm({
              title: "Delete project?",
              body: "Its chats stay but become unfiled. This can’t be undone.",
              ok: "Delete",
              danger: true,
            });
            if (!ok) return;
            await fetch("/api/projects/" + encodeURIComponent(projectId), {
              method: "DELETE",
            }).catch(function () {});
            ctx.navigate("/projects");
          },
        },
      ],
      { align: "right", trigger: this },
    );
  });

  $("#newChat").addEventListener("click", function () {
    ctx.navigate("/?new=1&project=" + encodeURIComponent(projectId));
  });

  async function load() {
    var res;
    try {
      res = await fetch("/api/projects/" + encodeURIComponent(projectId));
    } catch (_) {
      return;
    }
    if (!res.ok) {
      ctx.navigate("/projects");
      return;
    }
    var data = await res.json();
    project = data.project;
    document.title = project.name + " · Kloe";
    $("#crumbname").textContent = project.name;
    $("#pname").textContent = project.name;
    $("#pdesc").textContent = project.description || "";
    $("#pdesc").hidden = !project.description;
    $("#detail").hidden = false;
    renderChats(data.conversations || []);
    renderMemory();
    renderContext();
  }

  load();

  return {
    destroy: function () {
      document.removeEventListener("keydown", onKeydown);
    },
  };
}
