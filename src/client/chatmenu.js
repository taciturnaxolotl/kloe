/*
 * The per-conversation right-click / ⋮ menu, shared by the sidebar and the
 * Conversations page. openChatMenu(x, y, ctx) shows Rename + Delete (plus any
 * `ctx.extra` items) and performs the actions against the API, calling
 * `ctx.reload()` afterward.
 *   ctx: { id, title, dialogs, reload, align?, extra?: [{ label, danger, onClick }] }
 */
import { showContextMenu } from "./ctxmenu.js";
import { TRASH_ICON as TRASH } from "./icons.js";

async function renameChat(ctx) {
  var name = await ctx.dialogs.prompt({
    title: "Rename conversation",
    value: ctx.title || "",
    placeholder: "Conversation name",
    ok: "Save",
  });
  if (name === null) return; // cancelled
  try {
    await fetch("/api/conversations/" + encodeURIComponent(ctx.id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: name }),
    });
  } catch (_) { /* leave as-is on failure */ }
  if (ctx.reload) ctx.reload();
}

async function deleteChat(ctx) {
  var ok = await ctx.dialogs.confirm({
    title: "Delete conversation?",
    body: "This can't be undone.",
    ok: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await fetch("/api/conversations/" + encodeURIComponent(ctx.id), { method: "DELETE" });
  } catch (_) { /* ignore */ }
  if (ctx.reload) ctx.reload();
}

export function openChatMenu(x, y, ctx) {
  var items = (ctx.extra || []).slice();
  items.push({ label: "Rename", onClick: function () { renameChat(ctx); } });
  items.push({ label: "Delete", icon: TRASH, danger: true, onClick: function () { deleteChat(ctx); } });
  showContextMenu(x, y, items, { align: ctx.align });
}
