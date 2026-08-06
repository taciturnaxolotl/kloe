/*
 * Speculative navigation via the Speculation Rules API (Chromium). We prerender
 * the common cross-page destinations the moment the user *hints* at them —
 * `eagerness: moderate` fires on ~200ms hover or pointerdown — so the eventual
 * click activates an already-built, already-fetched page instantly instead of
 * kicking off a fresh document load.
 *
 * Scope: same-origin document links only, minus two exclusions:
 *   - /c/*   the chat pages open a live SSE stream on load; we don't want that
 *            running before the user actually navigates, so those are left to a
 *            normal (view-transition-smoothed) load.
 *   - /auth/* login/callback have real side effects; never speculate them.
 *
 * Only <a href> elements are eligible, so the client-side nav (sidebar recents,
 * New chat — plain buttons) is untouched and stays instant on its own. Pure
 * progressive enhancement: browsers without the API ignore the <script>.
 */
export function installSpeculation() {
  if (
    typeof HTMLScriptElement === "undefined" ||
    !HTMLScriptElement.supports ||
    !HTMLScriptElement.supports("speculationrules")
  )
    return;
  if (document.getElementById("speculationrules")) return; // once per document
  var rules = {
    prerender: [
      {
        source: "document",
        eagerness: "moderate",
        where: {
          and: [
            { href_matches: "/*" },
            { not: { href_matches: "/c/*" } },
            { not: { href_matches: "/auth/*" } },
          ],
        },
      },
    ],
  };
  var s = document.createElement("script");
  s.type = "speculationrules";
  s.id = "speculationrules";
  s.textContent = JSON.stringify(rules);
  document.head.appendChild(s);
}
