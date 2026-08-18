import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAuthCache, roleCan, roleFor } from "../src/auth";
import { FsBlobStore } from "../src/blobs";
import { Catalog } from "../src/catalog";
import { apiRoutes } from "../src/http";
import { setRegistry } from "../src/inference";
import { ProviderRegistry } from "../src/providers";
import { loadConfig, type RolePolicy, setConfig } from "../src/settings";
import { Store } from "../src/store";
import { toolSet } from "../src/tools";

/**
 * Roles: an owner runs the instance, a guest gets a chat. The tests that matter
 * are the ones about the boundary rather than the picker — the picker is a
 * suggestion, and a guest who names a model directly is the case worth being
 * sure about.
 */

const OWNER = "https://dunkirk.sh/";
const GUEST = "https://someone.else/";

function fixtureRegistry(): ProviderRegistry {
  const catalog = Catalog.fromRaw([
    {
      id: "acme",
      name: "Acme",
      type: "openai-compat",
      api_endpoint: "https://acme.test/v1",
      models: [
        { id: "cheap", name: "Cheap", context_window: 8000 },
        { id: "spendy", name: "Spendy", context_window: 200000 },
      ],
    },
  ]);
  return new ProviderRegistry(catalog, {
    config: { providers: [{ id: "acme", apiKey: "$ACME_KEY" }] },
  });
}

/** Owners by name, plus (optionally) the provider role that maps to owner. */
function configure(owners: string[], ownerRole?: string): void {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  const roles: Record<string, RolePolicy> =
    owners.length || ownerRole
      ? {
          owner: {
            admin: true,
            sandbox: true,
            publish: true,
            models: ["*"],
            search: ["*"],
            subs: owners,
            providerRoles: ownerRole ? [ownerRole] : [],
          },
          // Guests may pick from one provider's models here; what they see is
          // whichever of those they turned on.
          guest: {
            admin: false,
            sandbox: false,
            publish: false,
            models: ["acme/cheap"],
            search: [],
            subs: [],
            providerRoles: [],
          },
        }
      : {};
  setConfig({ ...base, auth: { ...base.auth, enabled: true, roles } });
  resetAuthCache();
}

/**
 * Assigning a role writes the config overlay, so each test points it at a file
 * it owns. Without this the suite would edit the checkout's own data/ directory.
 */
function overlayIn(dir: string): void {
  process.env.KLOE_OVERLAY = join(dir, "overrides.json");
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const tmpDirs: string[] = [];
function freshApp() {
  const tmp = mkdtempSync(join(tmpdir(), "kloe-roles-"));
  tmpDirs.push(tmp);
  overlayIn(tmp);
  const store = new Store(join(tmp, "test.db"));
  const blobs = new FsBlobStore(join(tmp, "blobs"));
  const server = Bun.serve({ port: 0, routes: apiRoutes({ store, blobs }) });
  servers.push(server);
  return { base: server.url.origin, store };
}
afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** A session cookie for `sub`, so a request arrives as that person. */
let sid = 0;
function as(store: Store, sub: string, providerRole?: string): { cookie: string } {
  const id = `sid-${sub}-${sid++}`;
  store.createSession(id, sub, {}, Date.now() + 600_000);
  if (providerRole !== undefined) store.setUserRole(sub, providerRole);
  return { cookie: `kloe_session=${encodeURIComponent(id)}` };
}

beforeEach(() => {
  setRegistry(fixtureRegistry());
});
afterEach(() => {
  setConfig(null);
  resetAuthCache();
  delete process.env.KLOE_OVERLAY;
});

test("an instance that names no owners has no guests", () => {
  configure([]);
  // Every instance behaved this way before roles existed; an upgrade must not
  // demote the only user of a single-user deployment.
  expect(roleFor(OWNER)).toBe("owner");
  expect(roleFor(GUEST)).toBe("owner");
  expect(roleFor(undefined)).toBe("owner");
});

test("auth off means there is nobody to be a guest to", () => {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({
    ...base,
    auth: {
      ...base.auth,
      enabled: false,
      roles: {
        owner: {
          admin: true,
          sandbox: true,
          publish: true,
          models: ["*"],
          search: ["*"],
          subs: [OWNER],
          providerRoles: [],
        },
      },
    },
  });
  resetAuthCache();
  expect(roleFor(undefined)).toBe("owner");
});

test("with owners named, everyone else is a guest", () => {
  configure([OWNER]);
  expect(roleFor(OWNER)).toBe("owner");
  expect(roleFor(GUEST)).toBe("guest");
});

test("the picker shows a role only what its bound allows", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();
  // Guests are bounded to acme/cheap by the fixture; the owner's bound is "*".
  const refs = async (sub: string) =>
    (
      (await (await fetch(`${base}/api/models/chat`, { headers: as(store, sub) })).json()) as any
    ).models.map((m: any) => m.ref);

  // Nothing curated by anyone yet: an empty starting selection means an empty
  // picker, exactly as an uncurated instance behaved before.
  expect(await refs(OWNER)).toEqual([]);

  for (const ref of ["acme/cheap", "acme/spendy"]) {
    for (const who of [OWNER, GUEST]) store.setUserModel(who, ref, { enabled: true });
  }
  expect(await refs(OWNER)).toEqual(["acme/cheap", "acme/spendy"]);
  expect(await refs(GUEST)).toEqual(["acme/cheap"]);
});

test("a guest naming a model the picker never offered is refused", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();
  for (const who of [OWNER, GUEST])
    store.setUserModel(who, "acme/spendy", { enabled: true, sortOrder: 0 });

  const prompt = (sub: string) =>
    fetch(`${base}/api/conversations/c1/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", ...as(store, sub) },
      body: JSON.stringify({ content: "hi", model: "acme/spendy" }),
    });

  expect((await prompt(GUEST)).status).toBe(403);
  // …and the owner, on the same model, is untouched by the check.
  expect((await prompt(OWNER)).status).toBe(202);
});

test("a guest cannot arrange a model their role may not reach", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();

  const put = (sub: string, ref: string) =>
    fetch(`${base}/api/models/mine`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(store, sub) },
      body: JSON.stringify({ ref, enabled: true }),
    });

  // The fixture bounds guests to acme/cheap.
  expect((await put(GUEST, "acme/spendy")).status).toBe(403);
  expect((await put(GUEST, "acme/cheap")).status).toBe(200);
  // The owner's bound is "*", so the same model is theirs to add.
  expect((await put(OWNER, "acme/spendy")).status).toBe(200);
});

test("a guest still cannot see the admin views", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();
  expect((await fetch(`${base}/api/roles`, { headers: as(store, GUEST) })).status).toBe(403);
  expect((await fetch(`${base}/api/roles`, { headers: as(store, OWNER) })).status).toBe(200);
});

// ---- roles from the identity provider --------------------------------------
// indiko assigns a role per app and returns it in the token response, so the
// list of who runs this instance can live where the accounts already do.

test("the provider's role decides, when the deployment says which role means owner", () => {
  configure([], "operator");
  expect(roleFor("https://anyone/", "operator")).toBe("owner");
  expect(roleFor("https://anyone/", "viewer")).toBe("guest");
  // No role assigned upstream is a guest, not an error.
  expect(roleFor("https://anyone/", undefined)).toBe("guest");
});

test("declaring any role is what brings roles into play", () => {
  // An instance that declares none has no guests to be; one that has said
  // anything about roles has plainly opted in.
  configure([], "operator");
  expect(roleFor("https://anyone/", undefined)).toBe("guest");
});

test("a named subject outranks whatever the provider says", () => {
  configure([OWNER], "operator");
  // The break-glass: it holds when the role was never assigned, which is the
  // state every pre-registered app starts in.
  expect(roleFor(OWNER, undefined)).toBe("owner");
  expect(roleFor(OWNER, "viewer")).toBe("owner");
  expect(roleFor(GUEST, "operator")).toBe("owner");
  expect(roleFor(GUEST, undefined)).toBe("guest");
});

test("a session carries the role it was signed in with", async () => {
  configure([], "operator");
  const { base, store } = freshApp();
  for (const who of [OWNER, GUEST])
    store.setUserModel(who, "acme/spendy", { enabled: true, sortOrder: 0 });

  const me = await (
    await fetch(`${base}/api/me`, { headers: as(store, GUEST, "operator") })
  ).json();
  expect((me as any).role).toBe("owner");

  // …and the same person without the role is held to the guest set.
  const forGuest = await fetch(`${base}/api/models/chat`, {
    headers: as(store, GUEST, "viewer"),
  });
  expect(((await forGuest.json()) as any).models).toEqual([]);
});

// ---- capabilities ----------------------------------------------------------
// The dividing line is who pays. A model or a search is governed by whose key
// covers it; the sandbox is the operator's own compute on a machine they pay
// for, and nobody can bring that for themselves.

test("a role without the sandbox capability is offered no shell tools", () => {
  configure([OWNER]);
  const store = new Store(":memory:");
  const forOwner = Object.keys(toolSet({ store, owner: OWNER, role: "owner" }));
  const forGuest = Object.keys(toolSet({ store, owner: GUEST, role: "guest" }));

  // Whatever the deployment configured, the guest's set never grows a tool that
  // executes somewhere. (With no executor configured neither has them, which is
  // why this compares the two rather than asserting a fixed list.)
  for (const shellTool of ["run_shell", "view_file", "write_file", "edit_file"]) {
    expect(forGuest).not.toContain(shellTool);
  }
  expect(forOwner.length).toBeGreaterThanOrEqual(forGuest.length);
});

test("a caller with no role at all keeps the powers it had before roles existed", () => {
  configure([]);
  const store = new Store(":memory:");
  // Scripts, tests and auth-off instances pass no role; they must not be
  // silently demoted into guests.
  expect(roleCan(roleFor(undefined), "sandbox")).toBe(true);
  expect(Object.keys(toolSet({ store }))).toEqual(Object.keys(toolSet({ store, role: "owner" })));
});

test("a guest may not mint a public link", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();
  const publish = (sub: string) =>
    fetch(`${base}/api/conversations/pub1/publications`, {
      method: "POST",
      headers: { "content-type": "application/json", ...as(store, sub) },
      body: JSON.stringify({ name: "doc.md", version: 1 }),
    });
  expect((await publish(GUEST)).status).toBe(403);
  // The owner gets past the gate (404 here only because the document is fictional).
  expect((await publish(OWNER)).status).not.toBe(403);
});

test("roles declared in config carry their own policy", () => {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({
    ...base,
    auth: {
      ...base.auth,
      enabled: true,
      roles: {
        staff: {
          admin: false,
          sandbox: true,
          publish: true,
          models: [],
          search: [],
          subs: [],
          providerRoles: ["staff"],
        },
        visitor: {
          admin: false,
          sandbox: false,
          publish: false,
          models: [],
          search: [],
          subs: [],
          providerRoles: ["visitor"],
        },
      },
    },
  });
  resetAuthCache();

  expect(roleFor("https://a/", "staff")).toBe("staff");
  expect(roleCan("staff", "sandbox")).toBe(true);
  expect(roleCan("staff", "admin")).toBe(false);
  expect(roleCan("visitor", "sandbox")).toBe(false);
  // A role the provider sends that this deployment never declared is a guest.
  expect(roleFor("https://a/", "somethingelse")).toBe("guest");
});

// ---- making a role take effect ---------------------------------------------
// The provider only reports a role during a fresh sign-in, so waiting for one
// is no way to demote somebody. An owner's own answer lands in the table every
// request reads.

test("a later sign-in does not undo an assignment made here", () => {
  // The provider keeps saying "operator"; naming them in a role says otherwise,
  // and a name wins.
  configure([], "operator");
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({
    ...base,
    auth: {
      ...base.auth,
      enabled: true,
      roles: {
        owner: {
          admin: true,
          sandbox: true,
          publish: true,
          models: ["*"],
          search: ["*"],
          subs: [],
          providerRoles: ["operator"],
        },
        guest: {
          admin: false,
          sandbox: false,
          publish: false,
          models: [],
          search: [],
          subs: [GUEST],
          providerRoles: [],
        },
      },
    },
  });
  resetAuthCache();
  expect(roleFor(GUEST, "operator")).toBe("guest");
});

test("the roles view reports the config, and says where each person's role came from", async () => {
  configure([OWNER], "operator");
  const { base, store } = freshApp();
  as(store, GUEST, "operator"); // signed in once, so kloe has heard of them

  const view = (await (
    await fetch(`${base}/api/roles`, { headers: as(store, OWNER) })
  ).json()) as any;

  expect(view.roles.map((r: any) => r.name).sort()).toEqual(["guest", "owner"]);
  expect(view.roles.find((r: any) => r.name === "owner").subs).toEqual([OWNER]);
  expect(view.users.find((u: any) => u.sub === GUEST)).toMatchObject({
    role: "operator", // what the provider said
    effective: "owner", // …which this deployment maps to owner
  });
});

test("signing someone out ends their sessions, and not your own", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();
  const theirs = as(store, GUEST);
  expect((await fetch(`${base}/api/me`, { headers: theirs })).status).toBe(200);

  const signOut = (sub: string, as_: { cookie: string }) =>
    fetch(`${base}/api/roles/signout`, {
      method: "POST",
      headers: { "content-type": "application/json", ...as_ },
      body: JSON.stringify({ sub }),
    });

  expect((await signOut(GUEST, as(store, GUEST))).status).toBe(403); // guests may not

  // Two sessions now (a second browser, and the one the refusal above made):
  // signing someone out ends every one of them, not the newest.
  const res = await signOut(GUEST, as(store, OWNER));
  expect(((await res.json()) as any).endedSessions).toBe(2);
  // Their cookie is now a cookie for nothing; the next visit is a fresh login,
  // which is the only moment the provider reports a role.
  expect((await fetch(`${base}/api/me`, { headers: theirs })).status).toBe(401);

  // Signing yourself out here would be a confusing way to log out.
  const self = as(store, OWNER);
  expect((await signOut(OWNER, self)).status).toBe(422);
});

// ---- your own model list ---------------------------------------------------
// Two layers: the operator decides what this instance offers your role, and you
// decide which of those you want to look at.

test("what you keep in your picker is yours alone", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();
  for (const ref of ["acme/cheap", "acme/spendy"]) {
    for (const who of [OWNER, GUEST]) store.setUserModel(who, ref, { enabled: true });
  }
  const owner = as(store, OWNER);
  const guest = as(store, GUEST);

  const picker = async (who: { cookie: string }) =>
    ((await (await fetch(`${base}/api/models/chat`, { headers: who })).json()) as any).models.map(
      (m: any) => m.ref,
    );

  // Nobody has curated anything of their own yet, so both inherit the
  // instance's starting selection — narrowed, for the guest, by their bound.
  expect(await picker(owner)).toEqual(["acme/cheap", "acme/spendy"]);
  expect(await picker(guest)).toEqual(["acme/cheap"]);

  const res = await fetch(`${base}/api/models/mine`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...owner },
    body: JSON.stringify({ ref: "acme/spendy", enabled: false }),
  });
  expect(res.status).toBe(200);

  expect(await picker(owner)).toEqual(["acme/cheap"]);
  // …and it changed nothing for anybody else.
  expect(await picker(guest)).toEqual(["acme/cheap"]);

  // Turning it back on is a row again, not a second kind of exception.
  await fetch(`${base}/api/models/mine`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...owner },
    body: JSON.stringify({ ref: "acme/spendy", enabled: true }),
  });
  expect(store.listUserModels(OWNER).map((m) => m.ref)).toContain("acme/spendy");
});

test("your list is what your role may reach, and you cannot curate past it", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();
  for (const who of [OWNER, GUEST])
    store.setUserModel(who, "acme/cheap", { enabled: true, sortOrder: 0 });
  for (const who of [OWNER, GUEST])
    store.setUserModel(who, "acme/spendy", { enabled: true, sortOrder: 1 });
  const guest = as(store, GUEST);
  const guestPicker = async () =>
    ((await (await fetch(`${base}/api/models/chat`, { headers: guest })).json()) as any).models.map(
      (m: any) => m.ref,
    );

  const mine = ((await (await fetch(`${base}/api/models/mine`, { headers: guest })).json()) as any)
    .models;
  expect(mine.map((m: any) => m.ref)).toEqual(["acme/cheap"]);
  expect(mine[0].enabled).toBe(true);

  // An exception for a model you cannot use would be a row that means nothing.
  const res = await fetch(`${base}/api/models/mine`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...guest },
    body: JSON.stringify({ ref: "acme/spendy", enabled: false }),
  });
  expect(res.status).toBe(403);
  // The refusal changed nothing: a model outside the bound was never theirs to
  // put in or take out.
  expect(await guestPicker()).toEqual(["acme/cheap"]);
});
