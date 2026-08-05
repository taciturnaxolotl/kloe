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

var RAIL_HTML =
  '<div class="railhead">' +
    '<span class="brand">kloe</span>' +
    '<div class="railactions">' +
      '<button class="icon" id="searchBtn" type="button" aria-label="Search conversations" title="Search conversations">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>' +
      '</button>' +
      '<button class="icon railx" id="railClose" type="button" aria-label="Close sidebar" title="Close sidebar">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>' +
      '</button>' +
    '</div>' +
  '</div>' +
  '<div class="railnav">' +
    '<button class="navrow" id="new" type="button">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>' +
      '<span>New chat</span>' +
    '</button>' +
    '<button class="navrow" id="chatsBtn" type="button">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"/></svg>' +
      '<span>Conversations</span>' +
    '</button>' +
  '</div>' +
  '<div class="raillabel">Recents</div>' +
  '<div class="raillist" id="railList"></div>' +
  '<a class="railfoot" href="/settings" title="Settings">' +
    '<img class="railpfp" id="railpfp" alt="" hidden>' +
    '<span class="railgreet" id="railgreet" hidden></span>' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg>' +
  '</a>';

var RECENTS = 8;
var CONV_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/></svg>';

/**
 * config:
 *   onSelect(id, title)  — open a conversation
 *   onNew()              — start a new chat
 *   activeId()           — id of the open conversation; highlights its recent,
 *                          or "New chat" when the id isn't saved yet. Optional.
 *   onOpenList()         — what search/Conversations do; defaults to navigating to /conversations
 *   active               — "conversations" marks that nav row current
 */
export function mountSidebar(config) {
  var $ = function (id) { return document.getElementById(id); };
  var appEl = $("app"), rail = $("rail"), scrim = $("scrim");
  rail.innerHTML = RAIL_HTML;
  var railList = $("railList");

  var railMql = window.matchMedia("(max-width: 720px)");
  function toggleRail() { appEl.classList.toggle(railMql.matches ? "rail-open" : "rail-collapsed"); }
  function closeRail() { appEl.classList.remove("rail-open"); }
  function openList() { if (config.onOpenList) config.onOpenList(); else window.location.href = "/conversations"; }

  function render(conversations) {
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

  return { render: render, closeRail: closeRail };
}
