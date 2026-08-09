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
  var abort = new AbortController(); // cancels the in-flight load on unmount

  // Small sessionStorage helpers so the panels (memory preview, context files)
  // paint instantly on a revisit and revalidate in the background.
  function ssGet(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }
  function ssSet(key, val) {
    try {
      sessionStorage.setItem(key, JSON.stringify(val));
    } catch (_) {}
  }

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
      rows.appendChild(
        convRow(c, {
          dialogs: ctx.dialogs,
          reload: loadChats,
          // Soft-nav; convRow otherwise falls back to a full-page window.location
          // (which also triggers the cross-document fade).
          onOpen: function (conv) {
            ctx.navigate("/c/" + encodeURIComponent(conv.id));
          },
        }),
      );
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
  var MEM_CACHE = "kloe:pmem:" + projectId;
  // Paint the pin name + a hint line (cached preview, "Loading…", or an error).
  function paintMem(pin, hint) {
    var el = $("#memBody");
    el.innerHTML = '<div class="pinname"></div><p class="lardhint"></p>';
    el.querySelector(".pinname").textContent = pin;
    el.querySelector(".lardhint").textContent = hint;
  }
  async function renderMemory() {
    var el = $("#memBody");
    var pin = project.lardProject;
    if (!pin) {
      el.innerHTML =
        '<p class="lardhint">No memory pinned. Pin a lard project so this project’s chats read and record durable context.</p>';
      return;
    }
    // Instant paint from cache if it's for the same pin; else show Loading.
    var cached = ssGet(MEM_CACHE);
    paintMem(pin, cached && cached.pin === pin ? cached.hint : "Loading…");
    try {
      var r = await fetch("/api/lard/context?project=" + encodeURIComponent(pin), {
        signal: abort.signal,
      });
      var hint;
      if (!r.ok) {
        hint =
          r.status === 409
            ? "Connect lard in Settings to view its memory."
            : "Couldn’t load memory.";
        paintMem(pin, hint);
        return;
      }
      var data = await r.json();
      var preview = (data.area || data.profile || "").trim();
      hint = preview
        ? preview.slice(0, 240) + (preview.length > 240 ? "…" : "")
        : "No memory recorded yet.";
      paintMem(pin, hint);
      ssSet(MEM_CACHE, { pin: pin, hint: hint });
    } catch (_) {
      if (abort.signal.aborted) return;
      paintMem(pin, "Couldn’t load memory.");
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
  var CTX_CACHE = "kloe:pctx:" + projectId;
  var ctxShown = null;
  function paintCtxFiles(files) {
    var j = JSON.stringify(files);
    if (j === ctxShown) return; // unchanged revalidation — no rebuild, no flash
    ctxShown = j;
    var el = $("#ctxBody");
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
  async function renderContext() {
    var cached = ssGet(CTX_CACHE);
    if (cached) paintCtxFiles(cached); // instant paint on a revisit
    var files;
    try {
      files =
        (
          await (
            await fetch("/api/projects/" + encodeURIComponent(projectId) + "/context", {
              signal: abort.signal,
            })
          ).json()
        ).files || [];
    } catch (_) {
      if (abort.signal.aborted) return;
      if (!cached) $("#ctxBody").innerHTML = '<p class="lardhint">Couldn’t load context files.</p>';
      return;
    }
    ssSet(CTX_CACHE, files);
    paintCtxFiles(files);
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

  // The detail payload survives a navigation in sessionStorage so a revisit paints
  // instantly instead of blanking for a round-trip; the fetch below revalidates.
  var CACHE = "kloe:project:";
  function readCache() {
    try {
      return JSON.parse(sessionStorage.getItem(CACHE + projectId) || "null");
    } catch (_) {
      return null;
    }
  }

  // Paint the project header + chats (and refresh Memory, which depends on the
  // project's pin). Deduped: an unchanged revalidation doesn't rebuild the DOM,
  // so the instant cached paint doesn't flash a round-trip later.
  var shownJson = null;
  function paint(data) {
    var j = JSON.stringify(data);
    if (j === shownJson) return;
    shownJson = j;
    project = data.project;
    document.title = project.name + " · Kloe";
    $("#crumbname").textContent = project.name;
    $("#pname").textContent = project.name;
    $("#pdesc").textContent = project.description || "";
    $("#pdesc").hidden = !project.description;
    renderChats(data.conversations || []);
    renderMemory();
  }

  async function load() {
    var res;
    try {
      res = await fetch("/api/projects/" + encodeURIComponent(projectId), { signal: abort.signal });
    } catch (_) {
      return;
    }
    if (!res.ok) {
      ctx.navigate("/projects");
      return;
    }
    var data = await res.json();
    try {
      sessionStorage.setItem(CACHE + projectId, JSON.stringify(data));
    } catch (_) {}
    paint(data);
  }

  // Reveal the structure right away with a loading state (so a soft-nav doesn't
  // show a blank pane), then paint cache instantly if we have it. Context files
  // depend only on the id, so fetch them in parallel with the main payload.
  $("#detail").hidden = false;
  $("#rows").innerHTML = '<div class="chatsempty">Loading…</div>';
  renderContext();
  var cached = readCache();
  if (cached && cached.project) paint(cached);
  load();

  return {
    destroy: function () {
      abort.abort();
      document.removeEventListener("keydown", onKeydown);
    },
  };
}
