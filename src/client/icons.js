/*
 * Icons, from Lucide's data (the `lucide` package) instead of hand-inlined SVG.
 * Call sites here build innerHTML strings and concatenate icons into markup, so
 * we serialize Lucide's IconNode ([[tag, attrs], …]) to an SVG *string* rather
 * than a DOM node. Named imports tree-shake, so only the icons below ship.
 * Sizing/colour come from CSS (`currentColor`, no width/height), as before.
 */
import {
  MessageSquare, Clock, Globe, Wrench, FileText, File,
  ArrowUpRight, ArrowUp, ChevronRight, GripVertical, EllipsisVertical, Trash2,
  Search, PanelLeft, MessageCirclePlus, MessagesSquare, Settings,
  Plus, Pencil, Folder,
  User, Users, Hash, Brain,
} from "lucide";

/** Serialize a Lucide IconNode to an SVG string. `attrs` override the defaults. */
export function icon(node, attrs) {
  var a = Object.assign(
    { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" },
    attrs || {},
  );
  var s = "<svg";
  for (var k in a) if (a[k] != null) s += " " + k + '="' + a[k] + '"';
  s += ">";
  for (var i = 0; i < node.length; i++) {
    s += "<" + node[i][0];
    var at = node[i][1] || {};
    for (var p in at) s += " " + p + '="' + at[p] + '"';
    s += "/>";
  }
  return s + "</svg>";
}

export var CONV_ICON = icon(MessageSquare, { "stroke-width": 1.8 });
export var FILE_ICON = icon(File, { "stroke-width": 1.8 });
export var SEND_ICON = icon(ArrowUp, { "stroke-width": 2.2 });
export var CHEV_ICON = icon(ChevronRight, { class: "chev", "stroke-width": 2.6 });
export var MORE_ICON = icon(EllipsisVertical);
export var GRIP_ICON = icon(GripVertical);
export var TRASH_ICON = icon(Trash2, { "stroke-width": 1.8 });
export var CLOCK_ICON = icon(Clock);
export var GLOBE_ICON = icon(Globe);
export var TOOL_ICON = icon(Wrench);
export var PAGE_ICON = icon(FileText);
export var EXT_ICON = icon(ArrowUpRight);
export var SEARCH_ICON = icon(Search);
export var PANEL_ICON = icon(PanelLeft);
export var NEWCHAT_ICON = icon(MessageCirclePlus, { "stroke-width": 1.8 });
export var CHATS_ICON = icon(MessagesSquare, { "stroke-width": 1.8 });
export var SETTINGS_ICON = icon(Settings, { "stroke-width": 1.7 });
export var PLUS_ICON = icon(Plus);
export var PENCIL_ICON = icon(Pencil, { "stroke-width": 1.8 });
export var FOLDER_ICON = icon(Folder, { "stroke-width": 1.8 });
export var USER_ICON = icon(User, { "stroke-width": 1.8 });
export var USERS_ICON = icon(Users, { "stroke-width": 1.8 });
export var HASH_ICON = icon(Hash, { "stroke-width": 1.8 });
export var BRAIN_ICON = icon(Brain, { "stroke-width": 1.7 });
