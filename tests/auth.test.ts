import { afterEach, expect, test } from "bun:test";
import {
  clientMetadata,
  gateApi,
  getSession,
  handleCallback,
  handleLogin,
  handleLogout,
  parseCookies,
  resetAuthCache,
} from "../src/auth";
import { loadConfig, setConfig } from "../src/settings";
import { Store } from "../src/store";

function memStore(): Store {
  return new Store(":memory:");
}
function enableAuth(over: Record<string, unknown> = {}): void {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({ ...base, auth: { ...base.auth, enabled: true, ...over } });
  resetAuthCache();
}
afterEach(() => {
  setConfig(null);
  resetAuthCache();
});

test("session store: create, read, delete, expire, sweep", () => {
  const s = memStore();
  s.createSession(
    "sid1",
    "https://idp/u/kieran",
    { name: "Kieran", picture: "p.png" },
    Date.now() + 60_000,
  );
  const got = s.getSession("sid1");
  expect(got?.sub).toBe("https://idp/u/kieran");
  expect(got?.profile.name).toBe("Kieran");
  s.deleteSession("sid1");
  expect(s.getSession("sid1")).toBeUndefined();

  s.createSession("sid2", "x", {}, Date.now() - 1); // already expired
  expect(s.getSession("sid2")).toBeUndefined(); // expired → dropped on read
  s.createSession("sid3", "x", {}, Date.now() - 1);
  s.sweepSessions();
  expect(s.getSession("sid3")).toBeUndefined();
});

test("parseCookies handles multiple values", () => {
  const req = new Request("https://k/", { headers: { cookie: "a=1; kloe_session=abc; b=two" } });
  expect(parseCookies(req)).toEqual({ a: "1", kloe_session: "abc", b: "two" });
});

test("gateApi is a no-op when auth is disabled", () => {
  const store = memStore();
  const routes = { "/api/x": { GET: () => Response.json({ ok: true }) } };
  expect(gateApi(routes, store)).toBe(routes);
});

test("gateApi 401s without a session, passes with one, and leaves /health open", async () => {
  enableAuth();
  const store = memStore();
  const routes = {
    "/health": { GET: (_req: Request) => Response.json({ ok: true }) },
    "/api/x": { GET: (_req: Request) => Response.json({ secret: 42 }) },
  };
  const gated = gateApi(routes, store);

  const noCookie = new Request("https://k/api/x");
  expect((await gated["/api/x"]!.GET(noCookie)).status).toBe(401);
  expect((await gated["/health"]!.GET(new Request("https://k/health"))).status).toBe(200); // open

  store.createSession("good", "https://idp/u/k", {}, Date.now() + 60_000);
  const withCookie = new Request("https://k/api/x", { headers: { cookie: "kloe_session=good" } });
  const ok = await gated["/api/x"]!.GET(withCookie);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ secret: 42 });
});

test("getSession reads the cookie and honors expiry", () => {
  const store = memStore();
  store.createSession("sid", "sub", {}, Date.now() + 60_000);
  expect(
    getSession(new Request("https://k/", { headers: { cookie: "kloe_session=sid" } }), store)?.sub,
  ).toBe("sub");
  expect(getSession(new Request("https://k/"), store)).toBeUndefined();
});

test("clientMetadata is a valid public CIMD derived from baseUrl", async () => {
  enableAuth({ baseUrl: "https://kloe.test", appName: "Kloe" });
  const meta = (await clientMetadata().json()) as Record<string, unknown>;
  expect(meta.client_id).toBe("https://kloe.test/client-metadata.json");
  expect(meta.redirect_uris).toEqual([
    "https://kloe.test/auth/callback",
    "https://kloe.test/lard/callback",
  ]);
  expect(meta.token_endpoint_auth_method).toBe("none"); // public client, no secret
});

// ---- full login → callback flow against a fake IdP ----------------------

function fakeIdp(tokenBody: Record<string, unknown>) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: url.origin + "/authorize",
          token_endpoint: url.origin + "/token",
        });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        if (!form.get("code_verifier") || form.get("grant_type") !== "authorization_code") {
          return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        return Response.json({ iss: url.origin, ...tokenBody });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

async function runLogin(_store: Store): Promise<{ state: string; oauthCookie: string }> {
  const res = await handleLogin(new Request("https://kloe.test/auth/login?returnTo=/c/42"));
  expect(res.status).toBe(302);
  const authorize = new URL(res.headers.get("location")!);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("client_id")).toBe("https://kloe.test/client-metadata.json");
  const state = authorize.searchParams.get("state")!;
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("kloe_oauth="))!;
  return { state, oauthCookie: setCookie.split(";")[0]! };
}

test("full flow: login → callback mints a session and redirects to returnTo", async () => {
  const idp = fakeIdp({
    me: "https://idp/u/kieran",
    profile: { name: "Kieran", photo: "https://idp/k.png" },
  });
  try {
    enableAuth({ issuer: idp.url.origin, baseUrl: "https://kloe.test" });
    const store = memStore();
    const { state, oauthCookie } = await runLogin(store);

    const cb = new Request(
      `https://kloe.test/auth/callback?code=abc&state=${state}&iss=${encodeURIComponent(idp.url.origin)}`,
      {
        headers: { cookie: oauthCookie },
      },
    );
    const res = await handleCallback(cb, store);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/c/42"); // returnTo preserved
    const sid = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("kloe_session="))!
      .split(";")[0]!
      .split("=")[1]!;
    const session = store.getSession(decodeURIComponent(sid))!;
    expect(session.sub).toBe("https://idp/u/kieran");
    expect(session.profile.picture).toBe("https://idp/k.png"); // photo → picture
  } finally {
    idp.stop(true);
  }
});

test("callback rejects a state mismatch and an unauthorized sub", async () => {
  const idp = fakeIdp({ me: "https://idp/u/kieran", profile: { name: "Kieran" } });
  try {
    const store = memStore();
    enableAuth({ issuer: idp.url.origin, baseUrl: "https://kloe.test" });
    const { oauthCookie } = await runLogin(store);
    const bad = await handleCallback(
      new Request("https://kloe.test/auth/callback?code=abc&state=WRONG", {
        headers: { cookie: oauthCookie },
      }),
      store,
    );
    expect(bad.status).toBe(400); // state mismatch

    enableAuth({
      issuer: idp.url.origin,
      baseUrl: "https://kloe.test",
      allowedSubs: ["https://idp/u/someone-else"],
    });
    const { state, oauthCookie: c2 } = await runLogin(store);
    const denied = await handleCallback(
      new Request(`https://kloe.test/auth/callback?code=abc&state=${state}`, {
        headers: { cookie: c2 },
      }),
      store,
    );
    expect(denied.status).toBe(403); // sub not in allowlist
  } finally {
    idp.stop(true);
  }
});

test("logout drops the session and clears the cookie", () => {
  const store = memStore();
  store.createSession("sid", "sub", {}, Date.now() + 60_000);
  const res = handleLogout(
    new Request("https://kloe.test/auth/logout", { headers: { cookie: "kloe_session=sid" } }),
    store,
  );
  expect(res.status).toBe(302);
  expect(store.getSession("sid")).toBeUndefined();
  expect(
    res.headers
      .getSetCookie()
      .some((c) => /kloe_session=;|kloe_session=; /.test(c) || c.startsWith("kloe_session=;")),
  ).toBe(true);
});
