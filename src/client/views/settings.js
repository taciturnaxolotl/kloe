/*
 * Settings, as a router view, split into tabs. "Models" curates the chat picker
 * (GET /models; toggle visibility, rename, drag to order via partial PATCH
 * /models). "Memory" (shown only when lard is enabled) links this user's lard
 * account (Connect → /lard/connect, a real navigation) and inspects their memory.
 * Mounted into the shell's #viewOutlet.
 *
 * Converted from the standalone settings.js: client-owned markup, DOM lookups
 * scoped to `root`, dialogs via ctx, and a destroy() that removes the three
 * document-level drag/selection listeners (wired once per mount) so they don't
 * accumulate across visits.
 */
import * as smd from "streaming-markdown";
import { showContextMenu } from "../ctxmenu.js";
import {
  BRAIN_ICON,
  FOLDER_ICON,
  GRIP_ICON as GRIP,
  HASH_ICON,
  MORE_ICON,
  PENCIL_ICON,
  TRASH_ICON,
  USER_ICON,
  USERS_ICON,
} from "../icons.js";

var MENU_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>';

var TEMPLATE =
  '<header class="head">' +
  '<button class="icon menu" id="menu" type="button" aria-label="Toggle sidebar" title="Toggle sidebar">' +
  MENU_SVG +
  "</button>" +
  '<span class="title">Settings</span>' +
  "</header>" +
  '<div class="chatscroll"><div class="setpage">' +
  '<div class="settabs" id="settabs" role="tablist">' +
  '<button class="settab active" type="button" data-tab="models" role="tab">Models</button>' +
  '<button class="settab" type="button" data-tab="research" role="tab">Research</button>' +
  '<button class="settab" type="button" data-tab="memory" role="tab" hidden>Memory</button>' +
  "</div>" +
  '<section class="settabpanel" data-panel="models">' +
  '<p class="lede">Turn models on to add them to the chat picker, drag the enabled ones to set their order (⌘-click to move several at once), and give them display names.</p>' +
  '<div id="content">Loading…</div>' +
  "</section>" +
  '<section class="settabpanel" data-panel="research" hidden>' +
  '<p class="lede">Deep research runs two jobs. The <strong>lead</strong> plans the angles, reads each round of notes to decide what to chase next, and writes the report. The <strong>workers</strong> search and read pages — far more tokens, on a much narrower job. Running a strong lead over cheaper workers is usually better than running one model for both.</p>' +
  '<div class="rolepick" id="rolepick">Loading…</div>' +
  "</section>" +
  '<section class="settabpanel" data-panel="memory" hidden>' +
  '<div id="lardStatus" class="lardconn"></div>' +
  '<div id="lardInspector" class="lardinspect" hidden>' +
  '<aside class="lardbrowser">' +
  '<input id="lardSearch" class="lardsearch" type="search" placeholder="Search subjects" autocomplete="off">' +
  '<div class="lardlist" id="lardSubjects"></div>' +
  "</aside>" +
  '<div class="lardviewer" id="lardViewer"></div>' +
  "</div>" +
  "</section>" +
  "</div></div>";

var KINDS = [
  { kind: "profile", label: "Profile", icon: USER_ICON },
  { kind: "area", label: "Areas", icon: FOLDER_ICON },
  { kind: "topic", label: "Topics", icon: HASH_ICON },
  { kind: "person", label: "People", icon: USERS_ICON },
];
var KIND_LABEL = {};
var KIND_ICON = {};
KINDS.forEach(function (k) {
  KIND_LABEL[k.kind] = k.label;
  KIND_ICON[k.kind] = k.icon;
});
var KIND_SINGULAR = { profile: "Profile", area: "Area", topic: "Topic", person: "Person" };

function providerOf(ref) {
  return ref.split("/")[0];
}
function fmtCtx(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  return Math.round(n / 1000) + "k";
}
function cap(m) {
  var c = [];
  if (m.contextWindow) c.push(fmtCtx(m.contextWindow) + " ctx");
  if (m.reasoningLevels && m.reasoningLevels.length) c.push("reasoning");
  if (m.supportsImages) c.push("images");
  return c.join(" · ");
}

export function mount(root, _params, ctx) {
  root.innerHTML = TEMPLATE;
  var byId = function (id) {
    return root.querySelector("#" + id);
  };
  var content = byId("content");

  var byRef = Object.create(null);
  var allModels = [];
  var prefs = {};
  var dragActive = false;
  var lardSubjects = []; // full listing, for search filtering
  var activeSubjectPath = null;

  byId("menu").addEventListener("click", function () {
    ctx.toggleRail();
  });

  function seclabel(text) {
    var d = document.createElement("div");
    d.className = "seclabel";
    d.textContent = text;
    return d;
  }

  // Flash the row's inline indicator: "saved" (green) or "failed" (red).
  function flash(el, ok) {
    if (!el) return;
    el.textContent = ok ? "saved" : "failed";
    el.classList.toggle("failed", !ok);
    el.classList.add("show");
    setTimeout(
      function () {
        el.classList.remove("show");
      },
      ok ? 900 : 2200,
    );
  }
  async function patchRaw(ref, field, value) {
    var body = { ref: ref };
    body[field] = value;
    try {
      var res = await fetch("/api/models", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch (_e) {
      return false;
    }
  }
  async function patch(ref, field, value, savedEl) {
    flash(savedEl, await patchRaw(ref, field, value));
  }

  function modelCard(m, draggable) {
    var row = document.createElement("div");
    row.className = "modelrow" + (m.visible ? "" : " off");
    row.dataset.ref = m.ref;

    if (draggable) {
      var handle = document.createElement("button");
      handle.type = "button";
      handle.className = "drag";
      handle.setAttribute("aria-label", "Drag to reorder");
      handle.innerHTML = GRIP;
      row.appendChild(handle);
    } else {
      var spacer = document.createElement("span");
      spacer.className = "dragspace";
      row.appendChild(spacer);
    }

    var toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "toggle";
    toggle.checked = !!m.visible;
    toggle.setAttribute("aria-label", "Show in chat picker");

    var main = document.createElement("div");
    main.className = "modelmain";
    var nm = document.createElement("div");
    nm.className = "mname";
    nm.textContent = m.displayName || m.name;
    var meta = document.createElement("div");
    meta.className = "mmeta";
    meta.textContent = m.ref + (cap(m) ? "  ·  " + cap(m) : "");
    main.appendChild(nm);
    main.appendChild(meta);

    var rename = document.createElement("input");
    rename.type = "text";
    rename.className = "mrename";
    rename.placeholder = m.name;
    rename.value = m.displayName || "";

    var saved = document.createElement("span");
    saved.className = "saved";
    saved.textContent = "saved";

    // Enabling/disabling moves the model between sections, so re-render on success.
    toggle.addEventListener("change", async function () {
      var v = toggle.checked;
      if (await patchRaw(m.ref, "visible", v)) {
        m.visible = v;
        render();
      } else {
        toggle.checked = !v;
        flash(saved, false);
      }
    });
    rename.addEventListener("change", function () {
      var v = rename.value.trim();
      nm.textContent = v || m.name;
      patch(m.ref, "displayName", v === "" ? null : v, saved);
    });

    row.appendChild(toggle);
    row.appendChild(main);
    row.appendChild(rename);
    row.appendChild(saved);
    return row;
  }

  /** The two role pickers: enabled models, plus "same as the chat model". */
  function renderRoles() {
    var box = byId("rolepick");
    if (!box) return;
    box.innerHTML = "";
    var enabled = allModels.filter(function (m) {
      return m.visible;
    });
    if (!enabled.length) {
      box.innerHTML = '<p class="lede">Enable some models first.</p>';
      return;
    }
    [
      { key: "research.leadModel", label: "Lead", hint: "Plans, directs and writes." },
      { key: "research.workerModel", label: "Workers", hint: "Search and read." },
    ].forEach(function (role) {
      var row = document.createElement("label");
      row.className = "rolerow";
      var name = document.createElement("span");
      name.className = "rolename";
      name.textContent = role.label;
      var hint = document.createElement("span");
      hint.className = "rolehint";
      hint.textContent = role.hint;
      var sel = document.createElement("select");
      sel.className = "roleselect";
      // The default is not a model: it is "whatever the conversation is using",
      // which is what a run does today and what it should keep doing until
      // somebody deliberately chooses otherwise.
      var same = document.createElement("option");
      same.value = "";
      same.textContent = "Same as the chat model";
      sel.appendChild(same);
      enabled.forEach(function (m) {
        var o = document.createElement("option");
        o.value = m.ref;
        o.textContent = m.name || m.ref;
        sel.appendChild(o);
      });
      sel.value = prefs[role.key] || "";
      var saved = document.createElement("span");
      saved.className = "saved";
      sel.addEventListener("change", async function () {
        var body = {};
        body[role.key] = sel.value || null;
        try {
          var res = await fetch("/api/prefs", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(String(res.status));
          prefs = (await res.json()).prefs || {};
          flash(saved, true);
        } catch (_) {
          sel.value = prefs[role.key] || ""; // put it back: nothing was saved
          flash(saved, false);
        }
      });
      row.appendChild(name);
      row.appendChild(hint);
      row.appendChild(sel);
      row.appendChild(saved);
      box.appendChild(row);
    });
  }

  function render() {
    renderRoles();
    byRef = Object.create(null);
    allModels.forEach(function (m) {
      byRef[m.ref] = m;
    });
    content.innerHTML = "";
    if (!allModels.length) {
      content.innerHTML =
        '<p class="lede">No models available. Enable providers in <code>providers.json</code> and restart the server.</p>';
      return;
    }

    // Enabled models: one ordered, draggable list (this order IS the picker order).
    var enabled = allModels
      .filter(function (m) {
        return m.visible;
      })
      .sort(function (a, b) {
        return (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name);
      });
    content.appendChild(seclabel("In chat"));
    var list = document.createElement("div");
    list.className = "modellist modellist-enabled";
    if (enabled.length) {
      enabled.forEach(function (m) {
        list.appendChild(modelCard(m, true));
      });
    } else {
      var empty = document.createElement("div");
      empty.className = "modelempty";
      empty.textContent = "No models enabled yet — turn some on below.";
      list.appendChild(empty);
    }
    content.appendChild(list);
    if (enabled.length) wireDrag(list);

    // Disabled models: grouped by provider, not draggable.
    var groups = Object.create(null);
    allModels
      .filter(function (m) {
        return !m.visible;
      })
      .forEach(function (m) {
        var p = providerOf(m.ref);
        (groups[p] = groups[p] || []).push(m);
      });
    Object.keys(groups)
      .sort()
      .forEach(function (prov) {
        content.appendChild(seclabel(prov));
        var pl = document.createElement("div");
        pl.className = "modellist";
        groups[prov]
          .sort(function (a, b) {
            return a.name.localeCompare(b.name);
          })
          .forEach(function (m) {
            pl.appendChild(modelCard(m, false));
          });
        content.appendChild(pl);
      });
  }

  // ---- drag-to-reorder (writes each moved model's new index as sortOrder) ---
  function rowAfter(list, y) {
    var rows = Array.prototype.slice.call(
      list.querySelectorAll(".modelrow:not(.dragging):not(.dropslot)"),
    );
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return rows[i];
    }
    return null;
  }
  function commitOrder(list) {
    Array.prototype.slice.call(list.querySelectorAll(".modelrow")).forEach(function (row, i) {
      var m = byRef[row.dataset.ref];
      if (m && m.sortOrder !== i) {
        m.sortOrder = i;
        patch(row.dataset.ref, "sortOrder", i, row.querySelector(".saved"));
      }
    });
  }
  // Clear the enabled-list selection when a click lands outside it. Scoped to this
  // view's rows; the document listener is removed on destroy.
  function clearAllSelection() {
    Array.prototype.slice.call(root.querySelectorAll(".modelrow.selected")).forEach(function (r) {
      r.classList.remove("selected");
    });
  }
  function onDocMousedown(e) {
    if (!e.target.closest(".modellist-enabled")) clearAllSelection();
  }
  function onDocDragover(e) {
    if (dragActive) e.preventDefault();
  }
  function onDocDrop(e) {
    if (dragActive) e.preventDefault();
  }
  document.addEventListener("mousedown", onDocMousedown);
  document.addEventListener("dragover", onDocDragover);
  document.addEventListener("drop", onDocDrop);

  // Off-screen drag image: the lead card, faint offset cards behind, count badge.
  function buildGhost(group, lead) {
    var wrap = document.createElement("div");
    wrap.className = "dragghost";
    var n = group.length;
    if (n > 1) {
      var b = document.createElement("div");
      b.className = "ghostback";
      wrap.appendChild(b);
    }
    var card = document.createElement("div");
    card.className = "ghostcard";
    var nm = lead.querySelector(".mname");
    card.textContent = nm ? nm.textContent : "Model";
    wrap.appendChild(card);
    if (n > 1) {
      var badge = document.createElement("div");
      badge.className = "ghostbadge";
      badge.textContent = String(n);
      wrap.appendChild(badge);
    }
    return wrap;
  }

  function wireDrag(list) {
    var group = null,
      anchor = null,
      srcRow = null;
    function rows() {
      return Array.prototype.slice.call(list.querySelectorAll(".modelrow:not(.dropslot)"));
    }
    function clearSel() {
      rows().forEach(function (r) {
        r.classList.remove("selected");
      });
    }

    list.addEventListener("click", function (e) {
      if (e.target.closest(".toggle, .mrename")) return;
      var row = e.target.closest(".modelrow");
      if (!row) {
        clearSel();
        anchor = null;
        return;
      }
      var rs = rows();
      if (e.shiftKey && anchor && rs.indexOf(anchor) !== -1) {
        var a = rs.indexOf(anchor),
          b = rs.indexOf(row);
        var lo = Math.min(a, b),
          hi = Math.max(a, b);
        clearSel();
        for (var i = lo; i <= hi; i++) rs[i].classList.add("selected");
      } else if (e.metaKey || e.ctrlKey) {
        row.classList.toggle("selected");
        anchor = row;
      } else {
        clearSel();
        row.classList.add("selected");
        anchor = row;
      }
    });

    rows().forEach(function (row) {
      row.addEventListener("mousedown", function (e) {
        row.draggable = !e.target.closest(".toggle, .mrename");
      });
      row.addEventListener("mouseup", function () {
        row.draggable = false;
      });
      row.addEventListener("dragstart", function (e) {
        srcRow = row;
        if (!row.classList.contains("selected")) {
          clearSel();
          row.classList.add("selected");
          anchor = row;
        }
        group = rows().filter(function (r) {
          return r.classList.contains("selected");
        });
        dragActive = true;
        e.dataTransfer.effectAllowed = "move";
        try {
          e.dataTransfer.setData("text/plain", "");
        } catch (_) {}
        var ghost = buildGhost(group, row);
        document.body.appendChild(ghost);
        try {
          e.dataTransfer.setDragImage(ghost, 16, 24);
        } catch (_) {}
        setTimeout(function () {
          ghost.remove();
        }, 0);
        var picked = group;
        setTimeout(function () {
          if (!dragActive) return;
          picked.forEach(function (r) {
            r.classList.add(r === row ? "dropslot" : "dragging");
          });
        }, 0);
      });
      row.addEventListener("dragend", function () {
        row.draggable = false;
        dragActive = false;
        if (group) {
          var ref = row.nextSibling;
          while (ref && group.indexOf(ref) !== -1) ref = ref.nextSibling;
          group.forEach(function (r) {
            r.classList.remove("dragging");
            r.classList.remove("dropslot");
            list.insertBefore(r, ref);
          });
        }
        group = null;
        commitOrder(list);
      });
    });
    list.addEventListener("dragover", function (e) {
      if (!group || !srcRow) return;
      e.preventDefault();
      var after = rowAfter(list, e.clientY);
      if (after !== srcRow) list.insertBefore(srcRow, after); // after === null appends
    });
  }

  // ---- settings tabs ----
  function currentTab() {
    var active = root.querySelector(".settabpanel:not([hidden])");
    return active ? active.dataset.panel : "models";
  }
  function selectTab(name) {
    root.querySelectorAll(".settab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    root.querySelectorAll(".settabpanel").forEach(function (p) {
      p.hidden = p.dataset.panel !== name;
    });
    if (location.hash !== "#" + name) history.replaceState({}, "", location.pathname + "#" + name);
  }
  function setupTabs() {
    root.querySelectorAll(".settab").forEach(function (t) {
      t.addEventListener("click", function () {
        selectTab(t.dataset.tab);
      });
    });
    var search = byId("lardSearch");
    if (search)
      search.addEventListener("input", function () {
        renderSubjectList(search.value);
      });
  }

  // ---- lard (memory) ----
  function renderLard(el, connected) {
    el.innerHTML = "";
    var ic = document.createElement("div");
    ic.className = "lardconn-icon " + (connected ? "on" : "off");
    ic.innerHTML = BRAIN_ICON;
    var text = document.createElement("div");
    text.className = "lardconn-text";
    var title = document.createElement("div");
    title.className = "lardconn-title";
    title.textContent = connected ? "Memory connected" : "Memory not connected";
    var sub = document.createElement("div");
    sub.className = "lardconn-sub";
    sub.textContent = connected
      ? "Your chats can read and record durable context in lard."
      : "Connect lard so chats can read and update your durable context.";
    text.appendChild(title);
    text.appendChild(sub);
    var btn = document.createElement(connected ? "button" : "a");
    btn.className = "btn " + (connected ? "" : "primary");
    if (connected) {
      btn.type = "button";
      btn.textContent = "Disconnect";
      btn.onclick = async function () {
        btn.disabled = true;
        btn.textContent = "Disconnecting…";
        await fetch("/api/lard", { method: "DELETE" }).catch(function () {});
        byId("lardInspector").hidden = true;
        renderLard(el, false);
      };
    } else {
      btn.href = "/lard/connect";
      btn.textContent = "Connect";
    }
    el.appendChild(ic);
    el.appendChild(text);
    el.appendChild(btn);
  }
  async function loadLard() {
    var tabBtn = root.querySelector('.settab[data-tab="memory"]');
    var inspector = byId("lardInspector");
    var enabled = false,
      connected = false;
    try {
      var j = await (await fetch("/api/lard")).json();
      enabled = !!j.enabled;
      connected = !!j.connected;
    } catch (_) {}
    if (tabBtn) tabBtn.hidden = !enabled;
    if (!enabled) {
      if (currentTab() === "memory") selectTab("models");
      return;
    }
    renderLard(byId("lardStatus"), connected);
    inspector.hidden = !connected;
    if (connected) {
      byId("lardViewer").innerHTML = '<p class="lardhint">Select a subject to read or edit it.</p>';
      loadSubjects();
    }
    // After a connect round-trip, clear the flag and land on the Memory tab.
    if (location.search.indexOf("lard=") >= 0) {
      history.replaceState({}, "", location.pathname);
      selectTab("memory");
    }
  }
  async function loadSubjects() {
    var list = byId("lardSubjects");
    list.innerHTML = '<p class="lardhint">Loading…</p>';
    try {
      lardSubjects = (await (await fetch("/api/lard/memory")).json()).listing || [];
    } catch (_) {
      list.innerHTML = '<p class="lardhint">Failed to load memory.</p>';
      return;
    }
    renderSubjectList("");
  }
  async function refreshSubjectMeta() {
    try {
      lardSubjects = (await (await fetch("/api/lard/memory")).json()).listing || lardSubjects;
    } catch (_) {
      return;
    }
    renderSubjectList(byId("lardSearch").value);
  }

  function renderSubjectList(query) {
    var list = byId("lardSubjects");
    var q = (query || "").trim().toLowerCase();
    var items = !q
      ? lardSubjects
      : lardSubjects.filter(function (s) {
          return (
            ((s.name || "") + " " + (s.description || "") + " " + s.path)
              .toLowerCase()
              .indexOf(q) !== -1
          );
        });
    if (!lardSubjects.length) {
      list.innerHTML = '<p class="lardhint">No subjects yet. Your chats will record them here.</p>';
      return;
    }
    if (!items.length) {
      list.innerHTML = '<p class="lardhint">No subjects match “' + query + "”.</p>";
      return;
    }
    var groups = {};
    items.forEach(function (s) {
      (groups[s.kind] = groups[s.kind] || []).push(s);
    });
    var order = KINDS.map(function (k) {
      return k.kind;
    }).concat(
      Object.keys(groups).filter(function (k) {
        return !KIND_LABEL[k];
      }),
    );
    list.innerHTML = "";
    order.forEach(function (kind) {
      var subs = groups[kind];
      if (!subs || !subs.length) return;
      var h = document.createElement("div");
      h.className = "lardgrouphead";
      var gi = document.createElement("span");
      gi.className = "lardgroupicon";
      gi.innerHTML = KIND_ICON[kind] || HASH_ICON;
      var gl = document.createElement("span");
      gl.className = "lardgrouplabel";
      gl.textContent = KIND_LABEL[kind] || kind;
      var gc = document.createElement("span");
      gc.className = "lardcount";
      gc.textContent = subs.length;
      h.appendChild(gi);
      h.appendChild(gl);
      h.appendChild(gc);
      list.appendChild(h);
      subs.forEach(function (s) {
        var b = document.createElement("button");
        b.className = "lardsubject" + (s.path === activeSubjectPath ? " active" : "");
        b.type = "button";
        var n = document.createElement("span");
        n.className = "ln";
        n.textContent = s.name || s.path;
        b.appendChild(n);
        if (s.description) {
          var d = document.createElement("span");
          d.className = "ld";
          d.textContent = s.description;
          b.appendChild(d);
        }
        b.onclick = function () {
          activeSubjectPath = s.path;
          list.querySelectorAll(".lardsubject").forEach(function (x) {
            x.classList.remove("active");
          });
          b.classList.add("active");
          openSubject(s);
        };
        list.appendChild(b);
      });
    });
  }

  // Render a full markdown string into `el` via streaming-markdown (fed in one
  // shot). smd emits no raw HTML, so this is safe for stored memory content.
  function renderMarkdown(el, text) {
    el.innerHTML = "";
    var parser = smd.parser(smd.default_renderer(el));
    smd.parser_write(parser, text);
    smd.parser_end(parser);
  }

  async function openSubject(s) {
    var v = byId("lardViewer");
    v.innerHTML = '<p class="lardhint">Loading…</p>';
    var path = s.path,
      body;
    try {
      body =
        (await (await fetch("/api/lard/subject?path=" + encodeURIComponent(path))).json()).body ||
        "";
    } catch (_) {
      v.innerHTML = '<p class="lardhint">Failed to load subject.</p>';
      return;
    }
    if (activeSubjectPath !== path) return; // a newer selection won the race

    v.innerHTML = "";
    var head = document.createElement("div");
    head.className = "lardvhead";
    var titleWrap = document.createElement("div");
    titleWrap.className = "lardvtitle";
    var name = document.createElement("span");
    name.className = "lardvname";
    name.textContent = s.name || path;
    titleWrap.appendChild(name);
    if (KIND_SINGULAR[s.kind]) {
      var badge = document.createElement("span");
      badge.className = "lardvbadge";
      badge.textContent = KIND_SINGULAR[s.kind];
      titleWrap.appendChild(badge);
    }
    var menuBtn = document.createElement("button");
    menuBtn.className = "lardvmenu";
    menuBtn.type = "button";
    menuBtn.setAttribute("aria-label", "Subject options");
    menuBtn.innerHTML = MORE_ICON;
    var cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    var save = document.createElement("button");
    save.className = "btn primary";
    save.type = "button";
    save.textContent = "Save";
    var head2 = document.createElement("div");
    head2.className = "lardvactions";
    head2.appendChild(menuBtn);
    head2.appendChild(cancel);
    head2.appendChild(save);
    head.appendChild(titleWrap);
    head.appendChild(head2);
    var pathEl = document.createElement("div");
    pathEl.className = "lardvpath";
    pathEl.textContent = path;

    var prose = document.createElement("div");
    prose.className = "lardprose";
    v.appendChild(head);
    v.appendChild(pathEl);
    v.appendChild(prose);

    menuBtn.onclick = function (e) {
      e.stopPropagation();
      var r = menuBtn.getBoundingClientRect();
      showContextMenu(
        r.right,
        r.bottom + 4,
        [
          { label: "Edit", icon: PENCIL_ICON, onClick: showEdit },
          { label: "Delete subject", icon: TRASH_ICON, danger: true, onClick: deleteSubject },
        ],
        { align: "right", trigger: menuBtn },
      );
    };

    async function deleteSubject() {
      var ok = await ctx.dialogs.confirm({
        title: "Delete this subject?",
        body:
          "“" +
          (s.name || path) +
          "” will be permanently removed from your memory. This can’t be undone.",
        ok: "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        await fetch("/api/lard/subject?path=" + encodeURIComponent(path), { method: "DELETE" });
      } catch (_) {
        return;
      }
      lardSubjects = lardSubjects.filter(function (x) {
        return x.path !== path;
      });
      activeSubjectPath = null;
      renderSubjectList(byId("lardSearch").value);
      byId("lardViewer").innerHTML = '<p class="lardhint">Select a subject to read or edit it.</p>';
    }

    function showRead() {
      menuBtn.hidden = false;
      cancel.hidden = true;
      save.hidden = true;
      prose.className = "lardprose";
      if (body.trim()) renderMarkdown(prose, body);
      else prose.innerHTML = '<p class="lardhint">This subject is empty.</p>';
    }
    function showEdit() {
      menuBtn.hidden = true;
      cancel.hidden = false;
      save.hidden = false;
      cancel.onclick = showRead; // discard: fall back to the stored body
      prose.className = "lardprose editing";
      prose.innerHTML = "";
      var ta = document.createElement("textarea");
      ta.className = "lardedit";
      ta.value = body;
      ta.spellcheck = false;
      prose.appendChild(ta);
      ta.focus();
      save.textContent = "Save";
      save.disabled = true;
      ta.addEventListener("input", function () {
        save.disabled = ta.value === body;
      });
      ta.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          e.preventDefault();
          showRead();
        }
      });
      save.onclick = async function () {
        save.disabled = true;
        save.textContent = "Saving…";
        try {
          await fetch("/api/lard/subject?path=" + encodeURIComponent(path), {
            method: "PUT",
            headers: { "content-type": "text/markdown" },
            body: ta.value,
          });
          body = ta.value;
          showRead();
          refreshSubjectMeta();
        } catch (_) {
          save.disabled = false;
          save.textContent = "Save";
        }
      };
    }
    showRead();
  }

  // ---- boot the view (auth + sidebar are already up in the shell) ----
  setupTabs();
  if (location.hash === "#memory") selectTab("memory");
  loadLard();
  // Models and preferences together: a role picker lists enabled models, so
  // rendering it needs both and rendering it twice would flicker.
  Promise.all([
    fetch("/api/models").then(function (r) {
      return r.json();
    }),
    fetch("/api/prefs")
      .then(function (r) {
        return r.ok ? r.json() : { prefs: {} };
      })
      .catch(function () {
        return { prefs: {} };
      }),
  ])
    .then(function (both) {
      allModels = both[0].models || [];
      prefs = both[1].prefs || {};
      render();
    })
    .catch(function (e) {
      content.innerHTML = '<p class="lede">Failed to load models: ' + e.message + "</p>";
    });

  return {
    destroy: function () {
      document.removeEventListener("mousedown", onDocMousedown);
      document.removeEventListener("dragover", onDocDragover);
      document.removeEventListener("drop", onDocDrop);
    },
  };
}
