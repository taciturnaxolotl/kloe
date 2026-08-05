/*
 * The app sidebar, shared by the chat SPA and the Conversations page. It owns
 * the rail markup (injected into an empty <nav id="rail">) so there's a single
 * source of truth, renders the Recents list, and wires the nav + collapse/
 * overlay toggle. The host page supplies what "open a conversation" and "new
 * chat" mean (SPA navigation vs a full page load) and which conversation is
 * active. The panel toggle (#menu) lives in each page's own header. When the
 * host passes `dialogs`, right-clicking a recent opens the Rename/Delete menu.
 */
import { openChatMenu } from "./chatmenu.js";
import { installSpeculation } from "./prefetch.js";
import {
  CONV_ICON, SEARCH_ICON, PANEL_ICON, NEWCHAT_ICON, CHATS_ICON, SETTINGS_ICON,
} from "./icons.js";

var RAIL_HTML =
  '<div class="railhead">' +
    '<span class="brand">kloe</span>' +
    '<div class="railactions">' +
      '<a class="icon" id="searchBtn" href="/conversations" aria-label="Search conversations" title="Search conversations">' +
        SEARCH_ICON +
      '</a>' +
      '<button class="icon railx" id="railClose" type="button" aria-label="Close sidebar" title="Close sidebar">' +
        PANEL_ICON +
      '</button>' +
    '</div>' +
  '</div>' +
  '<div class="railnav">' +
    '<button class="navrow" id="new" type="button">' +
      NEWCHAT_ICON +
      '<span>New chat</span>' +
    '</button>' +
    '<a class="navrow" id="chatsBtn" href="/conversations">' +
      CHATS_ICON +
      '<span>Conversations</span>' +
    '</a>' +
  '</div>' +
  '<div class="raillabel">Recents</div>' +
  '<div class="raillist" id="railList"></div>' +
  '<a class="railfoot" href="/settings" title="Settings">' +
    '<img class="railpfp" id="railpfp" alt="" hidden>' +
    '<span class="railgreet" id="railgreet" hidden></span>' +
    SETTINGS_ICON +
  '</a>';

var RECENTS = 8;

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
  try { return JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null"); } catch (_) { return null; }
}
function writeRecents(list) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify((list || []).slice(0, RECENTS))); } catch (_) {}
}

export function mountSidebar(config) {
  var $ = function (id) { return document.getElementById(id); };
  var appEl = $("app"), rail = $("rail"), scrim = $("scrim");
  rail.innerHTML = RAIL_HTML;
  var railList = $("railList");

  var railMql = window.matchMedia("(max-width: 720px)");
  function toggleRail() { appEl.classList.toggle(railMql.matches ? "rail-open" : "rail-collapsed"); }
  function closeRail() { appEl.classList.remove("rail-open"); }
  // The nav links now carry href="/conversations", so a plain click navigates
  // (and hover prerenders it). On the Conversations page itself, onOpenList just
  // focuses the search box, so cancel the redundant navigation there.
  function openList(e) { if (config.onOpenList) { if (e) e.preventDefault(); config.onOpenList(); } }

  function render(conversations) {
    writeRecents(conversations);
    railList.innerHTML = "";
    var active = config.activeId ? config.activeId() : null;
    if (!conversations.length) {
      var e = document.createElement("div");
      e.className = "empty"; e.textContent = "No conversations yet";
      railList.appendChild(e);
    } else {
      conversations.slice(0, RECENTS).forEach(function (c) {
        var b = document.createElement("button");
        b.className = "conv"; b.type = "button";
        b.innerHTML = CONV_ICON;
        var name = document.createElement("span");
        name.className = "convname"; name.textContent = c.title || "Untitled";
        b.appendChild(name);
        if (c.id === active) b.setAttribute("aria-current", "true");
        b.onclick = function () { closeRail(); config.onSelect(c.id, c.title); };
        if (config.dialogs) {
          b.oncontextmenu = function (e) {
            e.preventDefault();
            openChatMenu(e.clientX, e.clientY, {
              id: c.id, title: c.title, dialogs: config.dialogs, reload: config.reload,
            });
          };
        }
        railList.appendChild(b);
      });
    }
    // Highlight "New chat" while the open conversation is brand new — it has an
    // id but isn't in the saved list yet (nothing persisted). Not on the
    // Conversations page, which has its own active nav row.
    var isNewChat = config.active !== "conversations" && !!active &&
      !conversations.some(function (c) { return c.id === active; });
    $("new").classList.toggle("active", isNewChat);
  }

  $("menu").addEventListener("click", toggleRail);
  $("railClose").addEventListener("click", toggleRail);
  scrim.addEventListener("click", closeRail);
  $("new").addEventListener("click", function () { closeRail(); config.onNew(); });
  $("chatsBtn").addEventListener("click", openList);
  $("searchBtn").addEventListener("click", openList);
  if (config.active === "conversations") $("chatsBtn").classList.add("active");

  installSpeculation(); // prerender cross-page nav on hover (Chromium)

  // Paint cached recents right away; the host page's fetch will refresh them.
  var cached = readRecents();
  if (cached && cached.length) render(cached);

  return { render: render, closeRail: closeRail };
}
