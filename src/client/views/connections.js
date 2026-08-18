/*
 * Connections: the accounts this user has linked, and the ones they could.
 *
 * Its own page rather than a settings tab, because it is the one settings
 * surface that belongs to whoever is looking at it. Settings is the operator's
 * (curation, roles, research); this is yours, guest or owner alike.
 *
 * ADDING A CONNECTION: write a source and put it in SOURCES. A source fetches
 * its own state and returns plain row descriptors; everything after that —
 * layout, logos, buttons, the expanding panel a device flow needs, the empty
 * state — is shared. Nothing below SOURCES should need to change to add one.
 *
 * A row descriptor:
 *   {
 *     key:       unique string
 *     name:      what it is called
 *     service:   for the logo lookup (optional)
 *     tag:       a short qualifier beside the name (optional)
 *     status:    one line under the name
 *     connected: boolean, drives the status dot
 *     actions:   [{ label, kind: "primary"|"", href?, onClick?(row, ctx) }]
 *     input:     { placeholder, onSubmit(value) } for a pasted secret (optional)
 *   }
 *
 * An action's onClick gets a `ctx` with { panel(), reload() }: `panel()` opens
 * the area under the row (the device code lives there) and `reload()` refetches
 * every source.
 */
import { logoFor } from "../logos.js";

var TEMPLATE =
  '<header class="head chatshead">' +
  '<button class="icon menu" data-menu type="button" aria-label="Toggle sidebar" title="Toggle sidebar">' +
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>' +
  "</button>" +
  '<span class="title">Connections</span>' +
  "</header>" +
  '<div class="chatscroll"><div class="setpage">' +
  '<p class="lede">Link an account and your chats use it instead of this instance’s. Whatever your account can reach turns up where you pick a model.</p>' +
  "<div data-sections>Loading…</div>" +
  "</div></div>";

async function getJSON(url, opts) {
  var res = await fetch(url, opts);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// ---- sources ---------------------------------------------------------------

/**
 * Provider accounts: an inference endpoint or a search engine, connected by
 * pasting a key or by running the provider's device flow.
 */
var providerAccounts = {
  id: "providers",
  async load() {
    var data = await getJSON("/api/credentials");
    var byKey = {};
    (data.connections || []).forEach(function (c) {
      byKey[c.service + "/" + c.providerId] = c;
    });

    // Two groups per service: what this instance runs or you have connected,
    // and the rest of the catalogue. The catalogue is forty-odd providers and
    // would bury the handful that matter, so it starts folded away.
    var out = [];
    [
      { service: "inference", title: "Models", more: "Other model providers" },
      { service: "search", title: "Search", more: "Other search engines" },
    ].forEach(function (g) {
      var mine = [];
      var rest = [];
      (data.providers || [])
        .filter(function (p) {
          return p.service === g.service;
        })
        .sort(function (a, b) {
          return a.id.localeCompare(b.id);
        })
        .forEach(function (p) {
          var conn = byKey[p.service + "/" + p.id];
          var row = providerRow(p, conn);
          (conn || !p.userOnly ? mine : rest).push(row);
        });
      // Connected first within the group; the rest keep their alphabet.
      mine.sort(function (a, b) {
        return (b.connected ? 1 : 0) - (a.connected ? 1 : 0);
      });
      if (mine.length) out.push({ title: g.title, rows: mine });
      if (rest.length) out.push({ title: g.more, rows: rest, collapsed: true });
    });
    return out;
  },
};

function providerRow(p, conn) {
  var path = "/api/credentials/" + encodeURIComponent(p.service) + "/" + encodeURIComponent(p.id);
  var row = {
    key: p.service + "/" + p.id,
    name: p.id,
    service: p.service,
    connected: !!conn,
    tag: !conn && p.userOnly ? "bring your own" : "",
    status: conn
      ? conn.kind === "oauth"
        ? "Connected" + (conn.label ? " as " + conn.label : "") + ". Billed to you."
        : "Your key " + (conn.label || "") + ". Billed to you."
      : p.userOnly
        ? "Not set up here. Connect an account to use it."
        : "Using this instance’s key.",
    actions: [],
  };

  if (conn) {
    row.actions.push({
      label: "Disconnect",
      onClick: async function (_row, ctx) {
        await fetch(path, { method: "DELETE" }).catch(function () {});
        ctx.reload();
      },
    });
    return row;
  }
  if (p.oauth) {
    row.actions.push({
      label: "Connect",
      kind: "primary",
      onClick: function (_row, ctx) {
        runDeviceFlow(path, ctx);
      },
    });
  }
  if (p.byok) {
    row.input = {
      placeholder: "Paste an API key",
      onSubmit: async function (value, ctx) {
        var res = await fetch("/api/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ service: p.service, providerId: p.id, apiKey: value }),
        }).catch(function () {
          return { ok: false };
        });
        if (res.ok) ctx.reload();
        return res.ok;
      },
    };
  }
  return row;
}

/** lard, the memory server. Its OAuth is a redirect, so its action is a link. */
var memory = {
  id: "memory",
  async load() {
    var j = await getJSON("/api/lard");
    if (!j.enabled) return [];
    return [
      {
        title: "Memory",
        rows: [
          {
            key: "lard",
            name: "lard",
            connected: !!j.connected,
            status: j.connected
              ? "Your chats can read and add to what it remembers about you."
              : "Connect it and your chats can read and add to what it remembers about you.",
            actions: [
              j.connected
                ? {
                    label: "Disconnect",
                    onClick: async function (_row, ctx) {
                      await fetch("/api/lard", { method: "DELETE" }).catch(function () {});
                      ctx.reload();
                    },
                  }
                : { label: "Connect", kind: "primary", href: "/lard/connect" },
            ],
          },
        ],
      },
    ];
  },
};

var SOURCES = [providerAccounts, memory];

// ---- the device flow, shared by any provider that offers one ---------------

/**
 * Show the code, open the page the user types it into, and poll until the
 * provider says they finished. The timer is owned by the panel: closing the
 * page or reloading the list stops it, so nothing keeps hitting a provider on
 * behalf of a view nobody is looking at.
 */
async function runDeviceFlow(basePath, ctx) {
  var panel = ctx.panel();
  panel.textContent = "Getting a code…";

  var start;
  try {
    start = await getJSON(basePath + "/device", { method: "POST" });
    if (start.error) throw new Error(start.error);
  } catch (e) {
    panel.textContent = "Couldn’t start: " + e.message;
    return;
  }

  panel.innerHTML = "";
  var code = document.createElement("div");
  code.className = "conncode";
  code.textContent = start.userCode;
  var hint = document.createElement("div");
  hint.className = "connhint";
  hint.textContent = "Type this code to approve, then come back. This page is watching for it.";
  var open = document.createElement("a");
  open.className = "btn primary";
  open.target = "_blank";
  open.rel = "noopener";
  open.href = start.verificationUrl;
  open.textContent = "Open approval page";
  panel.appendChild(code);
  panel.appendChild(hint);
  panel.appendChild(open);

  var url = basePath + "/device/" + encodeURIComponent(start.deviceCode);
  var tick = async function () {
    if (Date.now() > start.expiresAt) {
      hint.textContent = "That code ran out. Try again.";
      return;
    }
    var j = {};
    try {
      j = await getJSON(url);
    } catch (_) {}
    if (j.status === "connected") return ctx.reload();
    if (j.status === "denied") {
      hint.textContent = "That was denied.";
      return;
    }
    if (j.status === "expired") {
      hint.textContent = "That code ran out. Try again.";
      return;
    }
    ctx.setTimer(setTimeout(tick, 2000));
  };
  ctx.setTimer(setTimeout(tick, 2000));
}

// ---- rendering (shared by every source) ------------------------------------

function renderRow(row, ctx) {
  var el = document.createElement("div");
  el.className = "connrow" + (row.connected ? " on" : "");

  var dot = document.createElement("span");
  dot.className = "conndot";
  el.appendChild(dot);

  var text = document.createElement("div");
  text.className = "conntext";
  var title = document.createElement("div");
  title.className = "conntitle";
  var mark = row.service ? logoFor(row.service, row.name) : "";
  if (mark) {
    // The logo IS the name when there is one; the text would only repeat it.
    var logo = document.createElement("span");
    logo.className = "connlogo";
    logo.innerHTML = mark;
    logo.setAttribute("aria-label", row.name);
    title.appendChild(logo);
  } else {
    title.appendChild(document.createTextNode(row.name));
  }
  if (row.tag) {
    var tag = document.createElement("span");
    tag.className = "conntag";
    tag.textContent = row.tag;
    title.appendChild(tag);
  }
  var status = document.createElement("div");
  status.className = "connsub";
  status.textContent = row.status || "";
  text.appendChild(title);
  text.appendChild(status);
  el.appendChild(text);

  var panelEl = null;
  var rowCtx = {
    reload: ctx.reload,
    setTimer: ctx.setTimer,
    panel: function () {
      if (!panelEl) {
        panelEl = document.createElement("div");
        panelEl.className = "conndevice";
        el.appendChild(panelEl);
      }
      return panelEl;
    },
  };

  if (row.input) {
    var input = document.createElement("input");
    input.type = "password";
    input.className = "connkey";
    input.placeholder = row.input.placeholder;
    input.autocomplete = "off";
    input.addEventListener("change", async function () {
      var value = input.value.trim();
      if (!value) return;
      input.disabled = true;
      var ok = await row.input.onSubmit(value, rowCtx);
      input.value = "";
      input.disabled = false;
      if (!ok) input.placeholder = "That key was refused";
    });
    el.appendChild(input);
  }

  (row.actions || []).forEach(function (action) {
    var btn = document.createElement(action.href ? "a" : "button");
    btn.className = "btn " + (action.kind === "primary" ? "primary" : "");
    btn.textContent = action.label;
    if (action.href) {
      btn.href = action.href;
    } else {
      btn.type = "button";
      btn.onclick = function () {
        action.onClick(row, rowCtx);
      };
    }
    el.appendChild(btn);
  });
  return el;
}

export function mount(root, _params, ctx) {
  root.innerHTML = TEMPLATE;
  var menu = root.querySelector("[data-menu]");
  if (menu) menu.addEventListener("click", ctx.toggleRail);
  var host = root.querySelector("[data-sections]");
  var timers = [];
  var alive = true;

  function clearTimers() {
    timers.splice(0).forEach(clearTimeout);
  }
  var viewCtx = {
    reload: function () {
      clearTimers();
      load();
    },
    setTimer: function (t) {
      timers.push(t);
    },
  };

  async function load() {
    var groups = [];
    for (var i = 0; i < SOURCES.length; i++) {
      try {
        // A source that fails contributes nothing rather than emptying the
        // page: one provider being down should not hide the others.
        var got = await SOURCES[i].load();
        groups = groups.concat(got || []);
      } catch (_) {}
    }
    if (!alive) return;
    host.innerHTML = "";
    if (!groups.length) {
      host.innerHTML =
        '<p class="lede">Nothing to connect here yet. This instance has no providers that take an account of your own.</p>';
      return;
    }
    groups.forEach(function (group) {
      if (group.collapsed) {
        var fold = document.createElement("details");
        fold.className = "connfold";
        var summary = document.createElement("summary");
        summary.textContent = group.title + " (" + group.rows.length + ")";
        fold.appendChild(summary);
        group.rows.forEach(function (row) {
          fold.appendChild(renderRow(row, viewCtx));
        });
        host.appendChild(fold);
        return;
      }
      var label = document.createElement("div");
      label.className = "seclabel";
      label.textContent = group.title;
      host.appendChild(label);
      group.rows.forEach(function (row) {
        host.appendChild(renderRow(row, viewCtx));
      });
    });
  }

  load();
  return {
    destroy: function () {
      alive = false;
      clearTimers();
    },
  };
}
