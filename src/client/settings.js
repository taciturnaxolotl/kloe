/*
 * Model curation. Lists every model this deployment can run (GET /models, joined
 * to catalog metadata + curation state) and lets the operator toggle chat
 * visibility, set a display name, and order the picker (PATCH /models). Each
 * edit is a partial PATCH — omitted fields keep their stored value.
 */
(function () {
  "use strict";
  var content = document.getElementById("content");

  function group(models) {
    // Bucket by provider (the ref prefix) for a readable table.
    var by = {};
    models.forEach(function (m) {
      var prov = m.ref.split("/")[0];
      (by[prov] = by[prov] || []).push(m);
    });
    return by;
  }

  // Flash the row's inline indicator: "saved" (green) or "failed" (red).
  function flash(el, ok) {
    if (!el) return;
    el.textContent = ok ? "saved" : "failed";
    el.classList.toggle("failed", !ok);
    el.classList.add("show");
    setTimeout(function () { el.classList.remove("show"); }, ok ? 900 : 2200);
  }
  async function patch(ref, field, value, savedEl) {
    var body = { ref: ref };
    body[field] = value;
    try {
      var res = await fetch("/api/models", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      flash(savedEl, true);
    } catch (e) {
      flash(savedEl, false);
    }
  }

  function fmtCtx(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    return Math.round(n / 1000) + "k";
  }
  function cap(m) {
    var c = [];
    if (m.contextWindow) c.push(fmtCtx(m.contextWindow));
    if (m.reasoningLevels && m.reasoningLevels.length) c.push("reasoning");
    if (m.supportsImages) c.push("images");
    return c.join(" · ");
  }

  function render(models) {
    if (!models.length) {
      content.innerHTML = '<p class="lede">No models available. Enable providers in <code>providers.json</code> ' +
        'and restart the server.</p>';
      return;
    }
    var by = group(models);
    var table = document.createElement("table");
    table.className = "mtable";
    table.innerHTML = "<thead><tr><th>Show</th><th>Model</th><th>Display name</th><th>Order</th><th></th></tr></thead>";
    var tbody = document.createElement("tbody");

    Object.keys(by).sort().forEach(function (prov) {
      var head = document.createElement("tr");
      head.innerHTML = '<td class="prov" colspan="5">' + prov + "</td>";
      tbody.appendChild(head);

      by[prov].forEach(function (m) {
        var tr = document.createElement("tr");

        var tdToggle = document.createElement("td");
        var toggle = document.createElement("input");
        toggle.type = "checkbox"; toggle.className = "toggle"; toggle.checked = !!m.visible;
        tdToggle.appendChild(toggle);

        var tdName = document.createElement("td");
        tdName.innerHTML = '<div></div><div class="ref"></div>';
        tdName.children[0].textContent = m.name;
        tdName.children[1].textContent = m.ref;

        var tdDisplay = document.createElement("td");
        var nameInput = document.createElement("input");
        nameInput.type = "text"; nameInput.placeholder = m.name;
        nameInput.value = m.displayName || "";
        tdDisplay.appendChild(nameInput);

        var tdOrder = document.createElement("td");
        var orderInput = document.createElement("input");
        orderInput.type = "number"; orderInput.value = m.sortOrder || 0;
        tdOrder.appendChild(orderInput);

        var tdSaved = document.createElement("td");
        var saved = document.createElement("span");
        saved.className = "saved"; saved.textContent = "saved";
        var capEl = document.createElement("span");
        capEl.className = "cap"; capEl.textContent = cap(m);
        tdSaved.appendChild(capEl); tdSaved.appendChild(document.createTextNode(" ")); tdSaved.appendChild(saved);

        toggle.addEventListener("change", function () { patch(m.ref, "visible", toggle.checked, saved); });
        nameInput.addEventListener("change", function () {
          patch(m.ref, "displayName", nameInput.value.trim() === "" ? null : nameInput.value.trim(), saved);
        });
        orderInput.addEventListener("change", function () {
          patch(m.ref, "sortOrder", Number(orderInput.value) || 0, saved);
        });

        tr.appendChild(tdToggle); tr.appendChild(tdName); tr.appendChild(tdDisplay);
        tr.appendChild(tdOrder); tr.appendChild(tdSaved);
        tbody.appendChild(tr);
      });
    });

    table.appendChild(tbody);
    content.innerHTML = "";
    content.appendChild(table);
  }

  (async function () {
    try {
      var res = await fetch("/api/models");
      var body = await res.json();
      render(body.models || []);
    } catch (e) {
      content.innerHTML = '<p class="lede">Failed to load models: ' + e.message + "</p>";
    }
  })();
})();
