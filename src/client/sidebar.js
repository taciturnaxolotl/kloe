/*
 * The app sidebar, shared by the chat SPA and the Conversations page. The rail's
 * static chrome is baked into each page's HTML as an app shell (so it paints
 * before the JS bundle loads); this module wires that chrome up, renders the
 * Recents list, and handles the collapse/overlay toggle. The host page supplies
 * what "open a conversation" and "new chat" mean (SPA navigation vs a full page
 * load) and which conversation is active. The panel toggle (#menu) lives in each
 * page's own header. When the host passes `dialogs`, right-clicking a recent
 * opens the Rename/Delete menu.
 */
import { openChatMenu } from "./chatmenu.js";
import { CONV_ICON } from "./icons.js";
import { installSpeculation } from "./prefetch.js";

// The rail's static chrome (brand, nav links, footer) lives in each page's HTML
// as an app shell, so it paints before app.js even downloads. mountSidebar just
// wires it up and fills in the dynamic parts (recents, pfp/greet). Those inline
// icons mirror icons.js (Lucide) — keep the two in sync.

// Recents fills the rail rather than showing a fixed count: a tall monitor gets
// twenty, a laptop gets ten, and neither ends up with dead space under the list
// or a scrollbar inside a sidebar that already sits beside a scrolling thread.
// The floor covers a window too short to fit even that, where .raillist's own
// overflow takes over.
var MIN_RECENTS = 5;
// Only used before a real row has ever been measured; .conv is ~30px + the 1px
// flex gap. Every later render uses the measurement.
var ROW_H_FALLBACK = 31;
// How many to keep in the cross-page cache — enough to fill a tall window on the
// next page before its fetch lands.
var CACHE_RECENTS = 60;

/**
 * config:
 *   onSelect(id, title)  — open a conversation
 *   onNew()              — start a new chat
 *   activeId()           — id of the open conversation; highlights its recent,
 *                          or "New chat" when the id isn't saved yet. Optional.
 *   onOpenList()         — what search/Conversations do; defaults to navigating to /conversations
 *   active               — "conversations" marks that nav row current
 */
// Recents survive a cross-page navigation in sessionStorage, so the rail can
// paint them immediately on the next page instead of waiting on /api/conversations
// (the fetch still runs and re-renders — stale-while-revalidate).
var CACHE_KEY = "kloe:recents";
function readRecents() {
  try {
    return JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
  } catch (_) {
    return null;
  }
}
function writeRecents(list) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify((list || []).slice(0, CACHE_RECENTS)));
  } catch (_) {}
}

export function mountSidebar(config) {
  var $ = function (id) {
    return document.getElementById(id);
  };
  var appEl = $("app"),
    scrim = $("scrim");
  var railList = $("railList");

  var railMql = window.matchMedia("(max-width: 720px)");
  function toggleRail() {
    appEl.classList.toggle(railMql.matches ? "rail-open" : "rail-collapsed");
  }
  function closeRail() {
    appEl.classList.remove("rail-open");
  }
  // The nav links now carry href="/conversations", so a plain click navigates
  // (and hover prerenders it). On the Conversations page itself, onOpenList just
  // focuses the search box, so cancel the redundant navigation there.
  function openList(e) {
    if (config.onOpenList) {
      if (e) e.preventDefault();
      config.onOpenList();
    }
  }

  // Measured from a real row the first time one is painted, so the fit follows
  // the stylesheet rather than a number copied out of it.
  var rowH = 0;
  var lastList = null;
  function fits() {
    var h = railList.clientHeight;
    if (!h) return MIN_RECENTS; // not laid out yet (hidden rail, first paint)
    return Math.max(MIN_RECENTS, Math.floor(h / (rowH || ROW_H_FALLBACK)));
  }

  function render(conversations) {
    lastList = conversations;
    writeRecents(conversations);
    paint(conversations, fits());
    // Now that a row exists, measure it. If the real height changes the count,
    // repaint once — `paint` doesn't affect .raillist's own height (it's flex:1),
    // so this settles immediately rather than oscillating.
    var first = railList.firstElementChild;
    if (first && first.classList.contains("conv")) {
      var measured = first.getBoundingClientRect().height + 1; // + the flex gap
      if (measured > 0 && Math.abs(measured - rowH) > 0.5) {
        rowH = measured;
        var want = Math.min(fits(), conversations.length);
        if (want !== railList.childElementCount) paint(conversations, want);
      }
    }
  }

  function paint(conversations, count) {
    railList.innerHTML = "";
    var active = config.activeId ? config.activeId() : null;
    if (!conversations.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = "No conversations yet";
      railList.appendChild(e);
    } else {
      conversations.slice(0, count).forEach(function (c) {
        var b = document.createElement("button");
        b.className = "conv";
        b.type = "button";
        b.innerHTML = CONV_ICON;
        var name = document.createElement("span");
        name.className = "convname";
        name.textContent = c.title || "Untitled";
        b.appendChild(name);
        if (c.id === active) b.setAttribute("aria-current", "true");
        b.onclick = function () {
          closeRail();
          config.onSelect(c.id, c.title);
        };
        if (config.dialogs) {
          b.oncontextmenu = function (e) {
            e.preventDefault();
            openChatMenu(e.clientX, e.clientY, {
              id: c.id,
              title: c.title,
              dialogs: config.dialogs,
              reload: config.reload,
            });
          };
        }
        railList.appendChild(b);
      });
    }
    // Highlight "New chat" while the open conversation is brand new — it has an
    // id but isn't in the saved list yet (nothing persisted). Not on the
    // Conversations page, which has its own active nav row.
    // "New chat" lights up only on the chat view, and only for a brand-new chat
    // that has an id but isn't saved yet. onChat() lets the shell say whether the
    // chat view is even showing (a satellite view must not keep this lit).
    var onChat = config.onChat ? config.onChat() : config.active !== "conversations";
    var isNewChat =
      onChat &&
      !!active &&
      !conversations.some(function (c) {
        return c.id === active;
      });
    $("new").classList.toggle("active", isNewChat);
  }

  $("menu").addEventListener("click", toggleRail);
  $("railClose").addEventListener("click", toggleRail);
  scrim.addEventListener("click", closeRail);
  $("new").addEventListener("click", function () {
    closeRail();
    config.onNew();
  });
  $("chatsBtn").addEventListener("click", openList);
  $("searchBtn").addEventListener("click", openList);
  if (config.active === "conversations") $("chatsBtn").classList.add("active");

  // A taller window shows more recents, a shorter one fewer. Repaint only when
  // the count actually changes, so a drag-resize isn't a rebuild per frame.
  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      if (!lastList || !lastList.length) return;
      var want = Math.min(fits(), lastList.length);
      if (want !== railList.childElementCount) paint(lastList, want);
    }).observe(railList);
  }

  installSpeculation(); // prerender cross-page nav on hover (Chromium)

  // Paint cached recents right away; the host page's fetch will refresh them.
  var cached = readRecents();
  if (cached && cached.length) render(cached);

  return { render: render, closeRail: closeRail, toggleRail: toggleRail };
}
