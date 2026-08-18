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
  '<button class="settab" type="button" data-tab="connections" role="tab">Connections</button>' +
  '<button class="settab" type="button" data-tab="research" role="tab" hidden>Research</button>' +
  '<button class="settab" type="button" data-tab="memory" role="tab" hidden>Memory</button>' +
  '<button class="settab" type="button" data-tab="people" role="tab" hidden>People</button>' +
  "</div>" +
  '<section class="settabpanel" data-panel="connections" hidden>' +
  '<div id="connectionsHost"></div>' +
  "</section>" +
  '<section class="settabpanel" data-panel="models">' +
  '<p class="lede">Your picker. Turn models on, drag them into the order you want (⌘-click to move several at once), and rename any of them. Which models you can choose from is set in <code>kloe.json</code>; what you do with them is yours.</p>' +
  '<div id="content">Loading…</div>' +
  "</section>" +
  '<section class="settabpanel" data-panel="research" hidden>' +
  '<p class="lede">Deep research runs two jobs. The <strong>lead</strong> plans the angles, reads each round of notes to decide what to chase next, and writes the report. The <strong>workers</strong> search and read pages — far more tokens, on a much narrower job. Running a strong lead over cheaper workers is usually better than running one model for both.</p>' +
  '<div class="rolepick" id="rolepick">Loading…</div>' +
  "</section>" +
  '<section class="settabpanel" data-panel="people" hidden>' +
  '<div class="seclabel">Roles</div>' +
  '<div id="rolePolicy">Loading\u2026</div>' +
  '<div class="seclabel">People</div>' +
  '<div id="peopleList"></div>' +
  "</section>" +
  '<section class="settabpanel" data-panel="memory" hidden>' +
  '<p class="lede">What lard remembers about you. Connect or disconnect it under Connections.</p>' +
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
  var prefsConfig = {}; // what kloe.json sets, so a preference can say what it overrides
  /** A model ref as its display name, falling back to the ref itself. */
  function modelName(ref) {
    var m = byRef[ref];
    return (m && (m.name || m.ref)) || ref;
  }
  var dragActive = false;
  /** Non-admin roles this deployment declares; the model rows hand access to these. */
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
      var res = await fetch("/api/models/mine", {
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
    row.className = "modelrow" + (m.enabled ? "" : " off");
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
    toggle.checked = !!m.enabled;
    toggle.setAttribute("aria-label", "Show in my picker");

    var main = document.createElement("div");
    main.className = "modelmain";
    var nm = document.createElement("div");
    nm.className = "mname";
    nm.textContent = m.displayName || m.name;
    var meta = document.createElement("div");
    meta.className = "mmeta";
    meta.textContent =
      m.ref + (cap(m) ? "  ·  " + cap(m) : "") + (m.yours ? "  ·  your account" : "");
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
      return m.enabled;
    });
    if (!enabled.length) {
      box.innerHTML = '<p class="lede">Turn some models on first.</p>';
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
      // What "no choice here" actually means depends on kloe.json: with nothing
      // configured it is the conversation's own model, and with a line in the
      // file it is that model. Labelling both cases the same way would tell
      // someone the run uses the chat model while it uses something else.
      var configured = prefsConfig[role.key];
      var same = document.createElement("option");
      same.value = "";
      same.textContent = configured
        ? "From kloe.json — " + modelName(configured)
        : "Same as the chat model";
      sel.appendChild(same);
      enabled.forEach(function (m) {
        var o = document.createElement("option");
        o.value = m.ref;
        o.textContent = m.name || m.ref;
        sel.appendChild(o);
      });
      sel.value = prefs[role.key] || "";
      // Where the effective value comes from, said plainly next to it — and,
      // when it is a choice made here, how to take it back.
      var source = document.createElement("span");
      source.className = "rolesource";
      var paintSource = function () {
        if (prefs[role.key]) {
          source.textContent = "set here";
          source.title = configured
            ? "Clearing reverts to " + modelName(configured) + ", from kloe.json"
            : "Clearing reverts to the chat model";
        } else if (configured) {
          source.textContent = "from kloe.json";
          source.title = "Choosing a model here overrides the file";
        } else {
          source.textContent = "";
          source.title = "";
        }
      };
      paintSource();
      var saved = document.createElement("span");
      saved.className = "saved";
      sel.addEventListener("change", async function () {
        var patchBody = {};
        patchBody[role.key] = sel.value || null;
        try {
          var res = await fetch("/api/prefs", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patchBody),
          });
          if (!res.ok) throw new Error(String(res.status));
          var body = await res.json();
          prefs = body.prefs || {};
          prefsConfig = body.config || {};
          paintSource();
          flash(saved, true);
        } catch (_) {
          sel.value = prefs[role.key] || ""; // put it back: nothing was saved
          flash(saved, false);
        }
      });
      row.appendChild(name);
      row.appendChild(hint);
      row.appendChild(sel);
      row.appendChild(source);
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
        '<p class="lede">No models available. Add a provider to <code>kloe.json</code> and restart the server.</p>';
      return;
    }

    // Enabled models: one ordered, draggable list (this order IS the picker order).
    var enabled = allModels
      .filter(function (m) {
        return m.enabled;
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
      empty.textContent = "No models in your picker yet. Turn some on below.";
      list.appendChild(empty);
    }
    content.appendChild(list);
    if (enabled.length) wireDrag(list);

    // Disabled models: grouped by provider, not draggable.
    var groups = Object.create(null);
    allModels
      .filter(function (m) {
        return !m.enabled;
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

  // ---- roles + people ----
  // A report, not an editor: roles are declared in kloe.json, so the panel says
  // what that file adds up to. Signing someone out is the one thing here that
  // isn't config, and so the one button.
  var CAPS = [
    { key: "admin", label: "admin", hint: "Curate models, set preferences, open this page" },
    { key: "sandbox", label: "sandbox", hint: "Shell tools, which run on this machine" },
    { key: "publish", label: "publish", hint: "Share a chat on a public link" },
  ];
  var roleList = [];
  var people = [];
  /** What to call the identity provider in copy; its hostname reads best. */
  var providerName = "your login";

  function rolePolicyRow(role) {
    var row = document.createElement("div");
    row.className = "connrow";
    var text = document.createElement("div");
    text.className = "conntext";
    var title = document.createElement("div");
    title.className = "conntitle";
    title.textContent = role.name;
    var sub = document.createElement("div");
    sub.className = "connsub";
    var can = CAPS.filter(function (c) {
      return role[c.key];
    }).map(function (c) {
      return c.label;
    });
    var held = [];
    if ((role.subs || []).length) held.push(role.subs.length + " named");
    if ((role.providerRoles || []).length)
      held.push(providerName + ": " + role.providerRoles.join(", "));
    sub.textContent =
      (can.length ? "Can " + can.join(", ") : "Chat only") +
      (held.length ? " \u00b7 " + held.join(" \u00b7 ") : "");
    text.appendChild(title);
    text.appendChild(sub);
    row.appendChild(text);
    return row;
  }

  function personRow(user) {
    var row = document.createElement("div");
    row.className = "connrow";
    var dot = document.createElement("span");
    dot.className = "conndot";
    row.appendChild(dot);

    var text = document.createElement("div");
    text.className = "conntext";
    var title = document.createElement("div");
    title.className = "conntitle";
    title.textContent = user.sub;
    var sub = document.createElement("div");
    sub.className = "connsub";
    // Where the role came from matters more than the role itself: named in the
    // config, or whatever the provider said this time.
    var named = (
      roleList.find(function (r) {
        return r.name === user.effective;
      }) || {}
    ).subs;
    sub.textContent =
      (named || []).indexOf(user.sub) >= 0
        ? "Named in kloe.json"
        : user.role
          ? providerName + " calls them " + user.role
          : providerName + " gives them no role";
    text.appendChild(title);
    text.appendChild(sub);
    row.appendChild(text);

    var role = document.createElement("span");
    role.className = "conntag";
    role.textContent = user.effective;
    row.appendChild(role);

    var saved = document.createElement("span");
    saved.className = "saved";
    saved.textContent = "signed out";

    var out = document.createElement("button");
    out.type = "button";
    out.className = "btn";
    out.textContent = "Sign out";
    out.title = "Ends their sessions, so their next login re-reads their role.";
    out.onclick = async function () {
      out.disabled = true;
      var res = await fetch("/api/roles/signout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sub: user.sub }),
      }).catch(function () {
        return { ok: false };
      });
      out.disabled = false;
      flash(saved, res.ok);
    };
    row.appendChild(out);
    row.appendChild(saved);
    return row;
  }

  function renderPeople() {
    var policy = byId("rolePolicy");
    if (!policy) return;
    policy.innerHTML = "";
    roleList.forEach(function (r) {
      policy.appendChild(rolePolicyRow(r));
    });
    var list = byId("peopleList");
    list.innerHTML = "";
    if (!people.length) {
      list.innerHTML = '<p class="lede">Nobody has signed in yet.</p>';
      return;
    }
    people.forEach(function (u) {
      list.appendChild(personRow(u));
    });
  }

  /**
   * One fetch feeds both halves of the roles story: the People panel, and the
   * per-role checkboxes on each model row. Owners only, so a non-owner simply
   * gets no tab and no checkboxes, which is what they cannot hand out anyway.
   */
  async function loadRoles() {
    var tabBtn = root.querySelector('.settab[data-tab="people"]');
    try {
      var res = await fetch("/api/roles");
      if (!res.ok) {
        if (tabBtn) tabBtn.hidden = true;
        return;
      }
      var j = await res.json();
      roleList = j.roles || [];
      people = j.users || [];
      if (j.provider) providerName = j.provider;
      // Reaching this endpoint at all is what proves the caller is an admin.
      ["people", "research"].forEach(function (name) {
        var t = root.querySelector('.settab[data-tab="' + name + '"]');
        if (t) t.hidden = false;
      });
      renderPeople();
    } catch (_) {
      if (tabBtn) tabBtn.hidden = true;
    }
  }

  // ---- lard (memory) ----
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
    if (!enabled) {
      if (tabBtn) tabBtn.hidden = true;
      if (currentTab() === "memory") selectTab("mine");
      return;
    }
    // The tab is only worth showing once there is something in it to read.
    if (tabBtn) tabBtn.hidden = !connected;
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

  // Connections are the same list the standalone page shows, mounted here so
  // one page holds everything a person adjusts about themselves.
  var connections = null;
  import("./connections.js").then(function (mod) {
    var host = byId("connectionsHost");
    if (host) connections = mod.mountList(host);
  });

  // Roles first: the model rows draw a checkbox per role, so they need the list
  // before they render.
  loadRoles();
  if (location.hash === "#memory") selectTab("memory");
  if (location.hash === "#connections") selectTab("connections");
  if (location.hash === "#mine") selectTab("models");
  if (location.hash === "#people") selectTab("people");
  loadLard();
  // Models and preferences together: a role picker lists enabled models, so
  // rendering it needs both and rendering it twice would flicker.
  Promise.all([
    fetch("/api/models/mine").then(function (r) {
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
      prefsConfig = both[1].config || {};
      render();
    })
    .catch(function (e) {
      content.innerHTML = '<p class="lede">Failed to load models: ' + e.message + "</p>";
    });

  return {
    destroy: function () {
      if (connections) connections.destroy();
      document.removeEventListener("mousedown", onDocMousedown);
      document.removeEventListener("dragover", onDocDragover);
      document.removeEventListener("drop", onDocDrop);
    },
  };
}
