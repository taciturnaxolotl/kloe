/*
 * Client-side router for the unified shell. One document, no full-page reloads
 * between sections. The chat view is the persistent home — its DOM and live SSE
 * stream stay mounted in #chatShell — while satellite routes (Conversations,
 * Projects, a project, Settings) mount a view module into #viewOutlet and unmount
 * on the way out.
 *
 * A route resolves to one of:
 *   { kind: "chat", params }              — show #chatShell, hand params to enterChat
 *   { kind: "view", load, params }         — hide it, mount load()'s module in the outlet
 *   null                                   — not a route we own; let the browser navigate
 *
 * `load` returns a promise of a module exporting `mount(root, params) -> { destroy? }`.
 * Unowned routes (null) fall through to a real navigation, so half-converted apps
 * still work: a link to a not-yet-SPA'd page just does a normal load.
 */

// A left click with no modifier on a plain, same-tab link — the only kind we
// intercept. Everything else (new-tab, download, external, middle-click) is left
// to the browser.
function isPlainClick(e, a) {
  return (
    !e.defaultPrevented &&
    e.button === 0 &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    a.target !== "_blank" &&
    !a.hasAttribute("download")
  );
}

export function createRouter(opts) {
  var outlet = opts.outlet;
  var chatShell = opts.chatShell;
  var resolve = opts.resolve; // (path) -> route | null
  var enterChat = opts.enterChat; // (params) -> void
  var current = null; // the mounted satellite view's { destroy? }, or null on chat

  function teardown() {
    if (current && typeof current.destroy === "function") {
      try {
        current.destroy();
      } catch (_) {}
    }
    current = null;
  }

  async function apply(route) {
    teardown();
    if (opts.onNav) opts.onNav(route.nav); // reflect the destination in the rail
    if (route.kind === "chat") {
      outlet.hidden = true;
      outlet.replaceChildren();
      chatShell.hidden = false;
      enterChat(route.params);
      return;
    }
    // A satellite view: give it a clean outlet and hide the chat (still live).
    chatShell.hidden = true;
    outlet.replaceChildren();
    outlet.hidden = false;
    var mod = await route.load();
    current = (await mod.mount(outlet, route.params, opts.ctx)) || {};
  }

  // history: "push" (a user navigation), "replace" (normalize without a new
  // entry), or "none" (we arrived from popstate/boot; the URL is already right).
  async function go(path, history) {
    var route = resolve(path);
    if (!route) {
      window.location.assign(path);
      return;
    }
    if (history === "push") window.history.pushState({}, "", path);
    else if (history === "replace") window.history.replaceState({}, "", path);

    if (opts.transition && document.startViewTransition) {
      try {
        await document.startViewTransition(function () {
          return apply(route);
        }).finished;
      } catch (_) {
        /* a superseded transition rejects; the newer nav already applied */
      }
    } else {
      await apply(route);
    }
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest("a[href]") : null;
    if (!a || !isPlainClick(e, a)) return;
    var url = new URL(a.getAttribute("href"), window.location.href);
    if (url.origin !== window.location.origin) return;
    var path = url.pathname + url.search;
    if (!resolve(path)) return; // not ours — let the browser do a real load
    e.preventDefault();
    if (path === window.location.pathname + window.location.search) return; // already here
    go(path, "push");
  });

  window.addEventListener("popstate", function () {
    go(window.location.pathname + window.location.search, "none");
  });

  return {
    // Programmatic navigation (sidebar recents, "New chat", in-view links that
    // prefer JS over an <a>). Same semantics as clicking a link.
    navigate: function (path) {
      if (path === window.location.pathname + window.location.search) return;
      go(path, "push");
    },
    // Initial route at boot: enter without pushing a history entry.
    start: function (path) {
      return go(path, "none");
    },
  };
}
