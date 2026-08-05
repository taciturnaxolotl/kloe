// Shared page-boot auth guard. Ask who we are; on a 401 (auth enabled, no
// session) redirect into the login flow, preserving where we were. When auth is
// off the endpoint returns {authenticated:false} and the page runs open. Every
// page entry calls this so a direct visit while logged out lands on login, not
// a broken page.
export async function requireAuth() {
  try {
    var res = await fetch("/api/me");
    if (res.status === 401) {
      location.href = "/auth/login?returnTo=" + encodeURIComponent(location.pathname + location.search);
      return null; // caller should stop; we're navigating away
    }
    return await res.json(); // the user, or {authenticated:false}
  } catch (_) {
    return { authenticated: false }; // network hiccup — don't hard-block
  }
}

// Show the signed-in avatar in the rail footer (next to Settings). No-op when
// there's no user/picture.
export function setPfp(user) {
  if (!user) return;
  if (user.name) {
    var greet = document.getElementById("railgreet");
    if (greet) { greet.textContent = "Hi " + user.name.split(/\s+/)[0] + "!"; greet.hidden = false; }
  }
  if (!user.picture) return;
  var img = document.getElementById("railpfp");
  if (!img) return;
  img.src = user.picture;
  img.hidden = false;
  img.onerror = function () { img.hidden = true; };
  if (user.name) img.alt = user.name;
}
