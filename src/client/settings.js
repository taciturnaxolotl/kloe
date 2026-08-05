/*
 * Model curation. Lists every model this deployment can run (GET /models) and
 * lets the operator toggle chat visibility, give a display name, and set the
 * picker order by dragging (each edit is a partial PATCH /models). Uses the
 * shared sidebar; the drag order is written back as each model's sortOrder.
 */
import { mountSidebar } from "./sidebar.js";
import { mountDialogs } from "./confirm.js";
import { requireAuth, setPfp } from "./authguard.js";

(function () {
  "use strict";
  var content = document.getElementById("content");
  var dialogs = mountDialogs();
  var sidebar = mountSidebar({
    onSelect: function (id) { window.location.href = "/?c=" + encodeURIComponent(id); },
    onNew: function () { window.location.href = "/?new=1"; },
    dialogs: dialogs,
    reload: loadSidebar,
  });
  async function loadSidebar() {
    try {
      var r = await fetch("/api/conversations");
      sidebar.render(((await r.json()).conversations) || []);
    } catch (_) { sidebar.render([]); }
  }

  var GRIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>';
  var byRef = Object.create(null);
  var allModels = [];
  function providerOf(ref) { return ref.split("/")[0]; }
  function seclabel(text) { var d = document.createElement("div"); d.className = "seclabel"; d.textContent = text; return d; }

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

  // Flash the row's inline indicator: "saved" (green) or "failed" (red).
  function flash(el, ok) {
    if (!el) return;
    el.textContent = ok ? "saved" : "failed";
    el.classList.toggle("failed", !ok);
    el.classList.add("show");
    setTimeout(function () { el.classList.remove("show"); }, ok ? 900 : 2200);
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
    } catch (e) { return false; }
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
      handle.type = "button"; handle.className = "drag";
      handle.setAttribute("aria-label", "Drag to reorder"); handle.innerHTML = GRIP;
      row.appendChild(handle);
    } else {
      var spacer = document.createElement("span"); spacer.className = "dragspace";
      row.appendChild(spacer);
    }

    var toggle = document.createElement("input");
    toggle.type = "checkbox"; toggle.className = "toggle"; toggle.checked = !!m.visible;
    toggle.setAttribute("aria-label", "Show in chat picker");

    var main = document.createElement("div"); main.className = "modelmain";
    var nm = document.createElement("div"); nm.className = "mname"; nm.textContent = m.displayName || m.name;
    var meta = document.createElement("div"); meta.className = "mmeta";
    meta.textContent = m.ref + (cap(m) ? "  ·  " + cap(m) : "");
    main.appendChild(nm); main.appendChild(meta);

    var rename = document.createElement("input");
    rename.type = "text"; rename.className = "mrename"; rename.placeholder = m.name; rename.value = m.displayName || "";

    var saved = document.createElement("span"); saved.className = "saved"; saved.textContent = "saved";

    // Enabling/disabling moves the model between sections, so re-render on success.
    toggle.addEventListener("change", async function () {
      var v = toggle.checked;
      if (await patchRaw(m.ref, "visible", v)) { m.visible = v; render(); }
      else { toggle.checked = !v; flash(saved, false); }
    });
    rename.addEventListener("change", function () {
      var v = rename.value.trim();
      nm.textContent = v || m.name;
      patch(m.ref, "displayName", v === "" ? null : v, saved);
    });

    row.appendChild(toggle); row.appendChild(main); row.appendChild(rename); row.appendChild(saved);
    return row;
  }

  function render() {
    byRef = Object.create(null);
    allModels.forEach(function (m) { byRef[m.ref] = m; });
    content.innerHTML = "";
    if (!allModels.length) {
      content.innerHTML = '<p class="lede">No models available. Enable providers in <code>providers.json</code> and restart the server.</p>';
      return;
    }

    // Enabled models: one ordered, draggable list (this order IS the picker order).
    var enabled = allModels.filter(function (m) { return m.visible; })
      .sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name); });
    content.appendChild(seclabel("In chat"));
    var list = document.createElement("div"); list.className = "modellist modellist-enabled";
    if (enabled.length) {
      enabled.forEach(function (m) { list.appendChild(modelCard(m, true)); });
    } else {
      var empty = document.createElement("div"); empty.className = "modelempty";
      empty.textContent = "No models enabled yet — turn some on below.";
      list.appendChild(empty);
    }
    content.appendChild(list);
    if (enabled.length) wireDrag(list);

    // Disabled models: grouped by provider, not draggable.
    var groups = Object.create(null);
    allModels.filter(function (m) { return !m.visible; }).forEach(function (m) {
      var p = providerOf(m.ref);
      (groups[p] = groups[p] || []).push(m);
    });
    Object.keys(groups).sort().forEach(function (prov) {
      content.appendChild(seclabel(prov));
      var pl = document.createElement("div"); pl.className = "modellist";
      groups[prov].sort(function (a, b) { return a.name.localeCompare(b.name); })
        .forEach(function (m) { pl.appendChild(modelCard(m, false)); });
      content.appendChild(pl);
    });
  }

  // ---- drag-to-reorder (writes each moved model's new index as sortOrder) ---
  function rowAfter(list, y) {
    var rows = Array.prototype.slice.call(list.querySelectorAll(".modelrow:not(.dragging):not(.dropslot)"));
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
  // Clear the enabled-list selection when a click lands anywhere outside it
  // (page background, a section label, the disabled rows) — standard
  // file-manager behavior. Wired once; survives re-renders.
  function clearAllSelection() {
    Array.prototype.slice.call(document.querySelectorAll(".modelrow.selected"))
      .forEach(function (r) { r.classList.remove("selected"); });
  }
  document.addEventListener("mousedown", function (e) {
    if (!e.target.closest(".modellist-enabled")) clearAllSelection();
  });

  // While a model drag is in flight, accept dragover/drop anywhere on the page
  // so releasing over the heading (or any spot outside the list) doesn't trigger
  // the browser's snap-back animation. Wired once.
  var dragActive = false;
  document.addEventListener("dragover", function (e) { if (dragActive) e.preventDefault(); });
  document.addEventListener("drop", function (e) { if (dragActive) e.preventDefault(); });

  // Off-screen drag image: the lead card, with faint offset cards behind it and
  // a count badge when more than one row is moving together.
  function buildGhost(group, lead) {
    var wrap = document.createElement("div");
    wrap.className = "dragghost";
    var n = group.length;
    // A single card behind the lead hints "more than one"; the badge carries
    // the exact count.
    if (n > 1) { var b = document.createElement("div"); b.className = "ghostback"; wrap.appendChild(b); }
    var card = document.createElement("div"); card.className = "ghostcard";
    var nm = lead.querySelector(".mname");
    card.textContent = nm ? nm.textContent : "Model";
    wrap.appendChild(card);
    if (n > 1) {
      var badge = document.createElement("div"); badge.className = "ghostbadge"; badge.textContent = String(n);
      wrap.appendChild(badge);
    }
    return wrap;
  }

  function wireDrag(list) {
    var group = null, anchor = null, srcRow = null;
    function rows() { return Array.prototype.slice.call(list.querySelectorAll(".modelrow:not(.dropslot)")); }
    function clearSel() { rows().forEach(function (r) { r.classList.remove("selected"); }); }

    // File-manager selection: plain click selects just that row, ⌘/Ctrl-click
    // toggles one, Shift-click extends a range from the anchor. Clicks on the
    // row's own controls (handle, toggle, rename) are left alone.
    list.addEventListener("click", function (e) {
      if (e.target.closest(".toggle, .mrename")) return;
      var row = e.target.closest(".modelrow");
      if (!row) { clearSel(); anchor = null; return; }
      var rs = rows();
      if (e.shiftKey && anchor && rs.indexOf(anchor) !== -1) {
        var a = rs.indexOf(anchor), b = rs.indexOf(row);
        var lo = Math.min(a, b), hi = Math.max(a, b);
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
      // Grabbing anywhere on the card starts a drag; only the toggle and rename
      // field are excluded so they stay clickable. draggable is toggled on
      // press so text/clicks elsewhere behave normally until a drag begins.
      row.addEventListener("mousedown", function (e) {
        row.draggable = !e.target.closest(".toggle, .mrename");
      });
      row.addEventListener("mouseup", function () { row.draggable = false; });
      row.addEventListener("dragstart", function (e) {
        srcRow = row;
        // Dragging an unselected row makes it the sole selection first (like
        // dragging an unselected file); dragging a selected row carries the
        // whole selection.
        if (!row.classList.contains("selected")) { clearSel(); row.classList.add("selected"); anchor = row; }
        group = rows().filter(function (r) { return r.classList.contains("selected"); });
        dragActive = true;
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", ""); } catch (_) {}
        // Stacked drag image (removed once the browser has snapshotted it).
        var ghost = buildGhost(group, row);
        document.body.appendChild(ghost);
        try { e.dataTransfer.setDragImage(ghost, 16, 24); } catch (_) {}
        setTimeout(function () { ghost.remove(); }, 0);
        // The grabbed row becomes the single drop slot; the rest of the
        // selection leaves the flow (display:none). Deferred a tick because
        // hiding the source node synchronously inside dragstart aborts the drag.
        var picked = group;
        setTimeout(function () {
          if (!dragActive) return;
          picked.forEach(function (r) { r.classList.add(r === row ? "dropslot" : "dragging"); });
        }, 0);
      });
      row.addEventListener("dragend", function () {
        row.draggable = false;
        dragActive = false;
        if (group) {
          // Gather the whole selection (in original order) at the drop slot's spot.
          var ref = row.nextSibling;
          while (ref && group.indexOf(ref) !== -1) ref = ref.nextSibling;
          group.forEach(function (r) {
            r.classList.remove("dragging"); r.classList.remove("dropslot");
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

  (async function () {
    var me = await requireAuth();
    if (!me) return; // redirecting to login
    setPfp(me);
    loadSidebar();
    try {
      var res = await fetch("/api/models");
      allModels = ((await res.json()).models) || [];
      render();
    } catch (e) {
      content.innerHTML = '<p class="lede">Failed to load models: ' + e.message + "</p>";
    }
  })();
})();
