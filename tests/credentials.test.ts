import { afterEach, expect, test } from "bun:test";
import { credentialsReady } from "../src/connectors";
import {
  byokAllowed,
  connectableProviders,
  credentialFor,
  disconnect,
  listConnections,
  oauthFlow,
  saveApiKey,
  saveOAuthGrant,
} from "../src/credentials";
import { exchangeToken, pollDeviceAuth, startDeviceAuth } from "../src/hyperauth";
import { flowFor, flowNames } from "../src/oauthflows";
import {
  BlendSearchProvider,
  CeramicSearchProvider,
  DuckDuckGoSearchProvider,
  ExaSearchProvider,
  searchProviderFor,
} from "../src/search";
import { decryptSecret, encryptSecret, hint } from "../src/secrets";
import { loadConfig, setConfig } from "../src/settings";
import { Store } from "../src/store";

/**
 * Per-user credentials: a key someone pasted, or a grant they ran. The tests
 * worth having are about the token rotation — hyper revokes a refresh token as
 * it spends it, so every mistake in this area costs the user their connection.
 */

const SUB = "https://someone.else/";

function configure(over: Record<string, unknown> = {}): void {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({
    ...base,
    security: { credentialKey: "test-key-material" },
    providers: [
      {
        id: "hyper",
        apiEndpoint: "https://hyper.test/v1",
        type: "hyper",
        oauth: { flow: "hyper-device", baseUrl: "https://hyper.test" },
        byok: true,
      },
      { id: "closed", apiEndpoint: "https://closed.test/v1", byok: false },
    ],
    ...over,
  } as never);
}
afterEach(() => setConfig(null));

const memStore = () => new Store(":memory:");

// ---- encryption ------------------------------------------------------------

test("a secret survives a round trip and refuses to be tampered with", () => {
  configure();
  const blob = encryptSecret("sk-live-abc123");
  expect(blob).not.toContain("sk-live");
  expect(decryptSecret(blob)).toBe("sk-live-abc123");

  // Flip a byte of the ciphertext: GCM's tag makes it fail rather than decrypt
  // to something plausible.
  const parts = blob.split(".");
  parts[3] = `${parts[3]!.slice(0, -2)}AA`;
  expect(() => decryptSecret(parts.join("."))).toThrow();
});

test("without a configured key, nothing is stored in the clear", () => {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({ ...base, security: { credentialKey: "" } } as never);
  expect(() => encryptSecret("sk-x")).toThrow(/credentialKey/);
  // The provider is still OFFERED — hiding it reads as "nothing to connect" —
  // and readiness is the separate thing that says why it won't work yet.
  expect(byokAllowed("inference", "hyper")).toBe(true);
  expect(credentialsReady()).toBe(false);
  expect(() => saveApiKey(memStore(), SUB, "inference", "hyper", "sk-x")).toThrow(/credentialKey/);
});

test("the hint identifies a key without handing it back", () => {
  expect(hint("sk-live-abcd1234")).toBe("••••1234");
  expect(hint("abc")).toBe("••••");
});

// ---- resolution ------------------------------------------------------------

test("a user with nothing of their own falls back to the deployment key", async () => {
  configure();
  expect(await credentialFor(memStore(), SUB, "inference", "hyper")).toBeUndefined();
  expect(await credentialFor(memStore(), undefined, "inference", "hyper")).toBeUndefined();
});

test("a pasted key is what gets sent", async () => {
  configure();
  const store = memStore();
  saveApiKey(store, SUB, "inference", "hyper", "sk-mine-9999");
  expect(await credentialFor(store, SUB, "inference", "hyper")).toMatchObject({
    secret: "sk-mine-9999",
  });
  expect(listConnections(store, SUB)).toEqual([
    {
      service: "inference",
      providerId: "hyper",
      kind: "key",
      label: "••••9999",
      expiresAt: undefined,
    },
  ]);

  disconnect(store, SUB, "inference", "hyper");
  expect(await credentialFor(store, SUB, "inference", "hyper")).toBeUndefined();
});

test("a provider that doesn't take user keys says so", () => {
  configure();
  expect(byokAllowed("inference", "closed")).toBe(false);
  expect(() => saveApiKey(memStore(), SUB, "inference", "closed", "sk-x")).toThrow(
    /does not accept/,
  );
});

test("a live access token is used as-is, without an exchange", async () => {
  configure();
  const store = memStore();
  saveOAuthGrant(
    store,
    SUB,
    "inference",
    "hyper",
    { accessToken: "at-live", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 },
    "Team Kieran",
  );
  const never = (async () => {
    throw new Error("should not have exchanged");
  }) as unknown as typeof fetch;
  expect(await credentialFor(store, SUB, "inference", "hyper", never)).toMatchObject({
    secret: "at-live",
  });
});

test("an expired token is exchanged, and the rotated pair is what gets stored", async () => {
  configure();
  const store = memStore();
  saveOAuthGrant(store, SUB, "inference", "hyper", {
    accessToken: "at-old",
    refreshToken: "rt-old",
    expiresAt: Date.now() - 1000,
  });

  let sentRefresh: string | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sentRefresh = JSON.parse(init.body as string).refresh_token;
    return new Response(
      JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  expect(await credentialFor(store, SUB, "inference", "hyper", fetchImpl)).toMatchObject({
    secret: "at-new",
  });
  expect(sentRefresh).toBe("rt-old");

  // The old refresh token is revoked upstream, so the new one MUST be what we
  // hold — this is the assertion that stands between a user and a dead link.
  const row = store.getCredentialRow(SUB, "inference", "hyper")!;
  expect(decryptSecret(row.refresh_token!)).toBe("rt-new");
  expect(decryptSecret(row.secret)).toBe("at-new");
  expect(row.expires_at).toBeGreaterThan(Date.now());
});

test("a refused refresh disconnects rather than failing every later run", async () => {
  configure();
  const store = memStore();
  saveOAuthGrant(store, SUB, "inference", "hyper", {
    accessToken: "at-old",
    refreshToken: "rt-revoked",
    expiresAt: Date.now() - 1000,
  });
  const fetchImpl = (async () =>
    new Response("refresh token revoked", { status: 401 })) as unknown as typeof fetch;

  expect(await credentialFor(store, SUB, "inference", "hyper", fetchImpl)).toBeUndefined();
  // Gone, so the next run quietly uses the deployment's key and settings shows
  // the connection as absent.
  expect(store.getCredentialRow(SUB, "inference", "hyper")).toBeUndefined();
});

test("two runs refreshing at once exchange the token exactly once", async () => {
  configure();
  const store = memStore();
  saveOAuthGrant(store, SUB, "inference", "hyper", {
    accessToken: "at-old",
    refreshToken: "rt-old",
    expiresAt: Date.now() - 1000,
  });

  let exchanges = 0;
  const fetchImpl = (async () => {
    exchanges++;
    await new Promise((r) => setTimeout(r, 50)); // the window a racer would slip into
    return new Response(
      JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const [a, b] = await Promise.all([
    credentialFor(store, SUB, "inference", "hyper", fetchImpl),
    credentialFor(store, SUB, "inference", "hyper", fetchImpl),
  ]);

  // A second exchange would have revoked the token the first one just stored,
  // leaving the user connected to nothing.
  expect(exchanges).toBe(1);
  expect(a).toMatchObject({ secret: "at-new" });
  expect(b).toMatchObject({ secret: "at-new" });
});

test("one user's credential is invisible to another", async () => {
  configure();
  const store = memStore();
  saveApiKey(store, SUB, "inference", "hyper", "sk-theirs-1111");
  expect(await credentialFor(store, "https://someone.new/", "inference", "hyper")).toBeUndefined();
});

// ---- the device flow ------------------------------------------------------

test("the device flow reads hyper's shapes, including its in-body errors", async () => {
  const start = (async () =>
    new Response(
      JSON.stringify({
        device_code: "dc-1",
        user_code: "ABCD-EFGH",
        verification_url: "https://hyper.test/device/authed/verify",
        expires_in: 900,
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const s = await startDeviceAuth("https://hyper.test/", "kloe", start);
  expect(s.deviceCode).toBe("dc-1");
  expect(s.userCode).toBe("ABCD-EFGH");
  expect(s.expiresAt).toBeGreaterThan(Date.now());
  // hyper's verify page reads ?user_code into the field, so the link carries
  // it and approving costs no typing.
  expect(s.verificationUrlComplete).toBe(
    "https://hyper.test/device/authed/verify?user_code=ABCD-EFGH",
  );

  const body = (b: unknown) =>
    (async () => new Response(JSON.stringify(b), { status: 200 })) as unknown as typeof fetch;

  // Hyper answers 200 with an `error` field for every not-yet state.
  expect(
    await pollDeviceAuth("https://hyper.test", "dc-1", body({ error: "authorization_pending" })),
  ).toEqual({ status: "pending" });
  expect(
    await pollDeviceAuth("https://hyper.test", "dc-1", body({ error: "access_denied" })),
  ).toEqual({ status: "denied" });
  // A grant is one-time: polling again says invalid_grant, which is not a retry.
  expect(
    await pollDeviceAuth("https://hyper.test", "dc-1", body({ error: "invalid_grant" })),
  ).toEqual({ status: "expired" });

  const granted = await pollDeviceAuth(
    "https://hyper.test",
    "dc-1",
    body({ refresh_token: "rt-1", team_name: "Team Kieran", team_id: "t1" }),
  );
  expect(granted).toEqual({
    status: "granted",
    grant: { refreshToken: "rt-1", teamName: "Team Kieran", teamId: "t1", userId: undefined },
  });
});

test("an incomplete exchange is an error, not a half-stored connection", async () => {
  const half = (async () =>
    new Response(JSON.stringify({ access_token: "at-1" }), {
      status: 200,
    })) as unknown as typeof fetch;
  await expect(exchangeToken("https://hyper.test", "rt-1", half)).rejects.toThrow(/incomplete/);
});

// ---- connectors ------------------------------------------------------------
// The service is part of a credential's identity, not a suffix on its name.

test("the same provider name under two services is two accounts", async () => {
  configure();
  const store = memStore();
  saveApiKey(store, SUB, "inference", "hyper", "sk-inference-1111");
  saveApiKey(store, SUB, "search", "exa", "sk-search-2222");

  expect(await credentialFor(store, SUB, "inference", "hyper")).toMatchObject({
    secret: "sk-inference-1111",
  });
  expect(await credentialFor(store, SUB, "search", "exa")).toMatchObject({
    secret: "sk-search-2222",
  });
  // Neither leaks into the other's service.
  expect(await credentialFor(store, SUB, "search", "hyper")).toBeUndefined();
  expect(await credentialFor(store, SUB, "inference", "exa")).toBeUndefined();

  // …and disconnecting one leaves the other alone.
  disconnect(store, SUB, "search", "exa");
  expect(await credentialFor(store, SUB, "inference", "hyper")).toMatchObject({
    secret: "sk-inference-1111",
  });
});

test("a search engine this deployment never configured is still connectable", () => {
  configure();
  const offered = connectableProviders();
  const exa = offered.find((c) => c.service === "search" && c.id === "exa");
  expect(exa?.byok).toBe(true);
  // Marked so the UI can say the instance has no key of its own for it.
  expect(exa?.userOnly).toBe(true);
});

test("a user's own engines replace the deployment's rather than blending with them", async () => {
  configure();
  const store = memStore();
  // Nothing connected: whatever the deployment offers, which with no key
  // configured is the keyless fallback.
  expect(await searchProviderFor(store, SUB)).toBeInstanceOf(DuckDuckGoSearchProvider);

  saveApiKey(store, SUB, "search", "exa", "sk-exa-user");
  const mine = await searchProviderFor(store, SUB);
  expect(mine).toBeInstanceOf(ExaSearchProvider);

  // Two of their own blend with each other.
  saveApiKey(store, SUB, "search", "ceramic", "sk-ceramic-user");
  expect(await searchProviderFor(store, SUB)).toBeInstanceOf(BlendSearchProvider);
});

test("an unimplemented oauth flow is not offered, however the config names it", () => {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({
    ...base,
    security: { credentialKey: "k" },
    providers: [
      {
        id: "whatever",
        apiEndpoint: "https://x.test/v1",
        oauth: { flow: "not-a-real-flow", baseUrl: "https://x.test" },
      },
    ],
  } as never);
  // The connector drops it rather than offering a Connect button that can only
  // fail once someone presses it.
  expect(oauthFlow("inference", "whatever")).toBeUndefined();
  expect(flowNames()).toContain("hyper-device");
});

test("a hyper provider offers its device flow without being configured for it", () => {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({
    ...base,
    security: { credentialKey: "k" },
    // No `oauth` block: the type is enough, and the device endpoints sit at the
    // root of the host the API is on.
    providers: [{ id: "hyper", apiEndpoint: "https://hyper.charm.land/v1", type: "hyper" }],
  } as never);
  expect(oauthFlow("inference", "hyper")).toEqual({
    flow: "hyper-device",
    baseUrl: "https://hyper.charm.land",
  });
});

test("with no key to encrypt with, providers are still listed and marked not ready", () => {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({
    ...base,
    security: { credentialKey: "" },
    providers: [{ id: "hyper", apiEndpoint: "https://hyper.charm.land/v1", type: "hyper" }],
  } as never);

  // An empty list would read as "this deployment has nothing to offer", which
  // is a different problem with a different fix.
  expect(credentialsReady()).toBe(false);
  expect(connectableProviders().some((c) => c.id === "hyper")).toBe(true);
  // …and saving still refuses, so the promise the list makes is kept elsewhere.
  expect(() => saveApiKey(memStore(), SUB, "inference", "hyper", "sk-x")).toThrow(/credentialKey/);
});

test("a service with a device flow is offered even where the instance runs none", () => {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  // A deployment with one unrelated provider and no hyper anywhere.
  setConfig({
    ...base,
    security: { credentialKey: "k" },
    providers: [{ id: "llmsolutions", apiEndpoint: "https://llmsolutions.top/v1" }],
  } as never);

  const hyper = connectableProviders().find((c) => c.id === "hyper");
  // Signing in costs the operator nothing and spends the user's own credits,
  // so it needs no opt-in from them.
  expect(hyper?.oauth).toEqual({ flow: "hyper-device", baseUrl: "https://hyper.charm.land" });
  expect(hyper?.userOnly).toBe(true);
  expect(oauthFlow("inference", "hyper")).toBeTruthy();
});

// ---- which engines a role may spend ---------------------------------------

function withRole(role: string, search: string[], backends: string[]): void {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({
    ...base,
    security: { credentialKey: "k" },
    auth: {
      ...base.auth,
      enabled: true,
      roles: {
        [role]: { models: ["*"], search, providerRoles: [role] },
      },
    },
    search: {
      ...base.search,
      provider: "none",
      backends: backends.map((provider) => ({ provider, apiKey: "instance-key" })),
    },
  } as never);
}

test("a role searches only on the engines it is allowed", async () => {
  const store = memStore();
  withRole("guest", ["ceramic"], ["exa", "ceramic"]);
  // Two configured, one allowed: they get that one, not the blend.
  expect(await searchProviderFor(store, SUB, "guest")).toBeInstanceOf(CeramicSearchProvider);

  withRole("guest", ["*"], ["exa", "ceramic"]);
  expect(await searchProviderFor(store, SUB, "guest")).toBeInstanceOf(BlendSearchProvider);
});

test("a role allowed nothing gets no search at all", async () => {
  const store = memStore();
  withRole("guest", [], ["exa", "ceramic"]);
  // Null means the web_search tool is never offered, rather than offered and
  // spending somebody else's credits.
  expect(await searchProviderFor(store, SUB, "guest")).toBeNull();
});

test("the keyless engine needs no configuring, only naming", async () => {
  const store = memStore();
  withRole("guest", ["duckduckgo"], ["exa"]);
  // Nothing to bound: it takes no key and costs nobody anything.
  expect(await searchProviderFor(store, SUB, "guest")).toBeInstanceOf(DuckDuckGoSearchProvider);
});

test("an engine you connected yourself is yours to use, whatever the role allows", async () => {
  const store = memStore();
  withRole("guest", [], ["exa"]);
  saveApiKey(store, SUB, "search", "exa", "sk-my-own-exa");
  // Their key, their money: the role bounds the instance's engines, not theirs.
  expect(await searchProviderFor(store, SUB, "guest")).toBeInstanceOf(ExaSearchProvider);
});

// ---- codex: a credential a local tool already holds ------------------------

test("codex is offered everywhere, signs in by device code, and refreshes itself", async () => {
  configure();
  const codex = connectableProviders().find((c) => c.id === "codex");
  // No deployment configures it: the account is the user's and so is the bill.
  expect(codex?.oauth).toEqual({ flow: "codex", baseUrl: "https://auth.openai.com" });
  expect(codex?.byok).toBe(false); // a sign-in and a key box would be two doors
  expect(codex?.models?.length).toBeGreaterThan(0);

  const flow = flowFor("codex")!;

  // 1. a code to type in, and where to type it
  const started = await flow.start!(
    "",
    "kloe",
    (async () =>
      new Response(
        JSON.stringify({ device_auth_id: "da-1", user_code: "ABCD-EFGHI", interval: "5" }),
        { status: 200 },
      )) as unknown as typeof fetch,
  );
  expect(started.userCode).toBe("ABCD-EFGHI");
  expect(started.verificationUrl).toBe("https://auth.openai.com/codex/device");

  // 2. pending is a 403 here, not a body with an error in it
  const pending = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
  expect(await flow.poll!("", started.deviceCode, pending)).toEqual({ status: "pending" });

  // 3. approval yields a code plus the verifier to spend it with, and the poll
  //    finishes the exchange itself
  const idToken = [
    "x",
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-9" } }),
    ).toString("base64url"),
    "y",
  ].join(".");
  const calls: string[] = [];
  const approving = (async (url: string) => {
    calls.push(new URL(url).pathname);
    if (url.endsWith("/deviceauth/token")) {
      return new Response(
        JSON.stringify({ authorization_code: "ac-1", code_verifier: "cv-1", code_challenge: "cc" }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        access_token: "at-1",
        refresh_token: "rt-1",
        id_token: idToken,
        expires_in: 3600,
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const granted = await flow.poll!("", started.deviceCode, approving);
  expect(calls).toEqual(["/api/accounts/deviceauth/token", "/oauth/token"]);
  expect(granted).toMatchObject({
    status: "granted",
    grant: {
      tokens: { accessToken: "at-1", refreshToken: "rt-1" },
      // Without this the endpoint answers 401 to a perfectly good token.
      meta: { accountId: "acc-9" },
    },
  });
});

test("a codex grant refreshes on the public client id alone", async () => {
  configure();
  const store = memStore();
  saveOAuthGrant(
    store,
    SUB,
    "inference",
    "codex",
    { accessToken: "at-old", refreshToken: "rt-old", expiresAt: Date.now() - 1000 },
    "ChatGPT account",
    { accountId: "acc-9" },
  );

  let sent: Record<string, string> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const got = await credentialFor(store, SUB, "inference", "codex", fetchImpl);
  expect(got).toMatchObject({ secret: "at-new", meta: { accountId: "acc-9" } });
  expect(sent.grant_type).toBe("refresh_token");
  // OpenAI need not rotate it; keeping the old one is what makes a connection
  // last rather than expire on the next refresh.
  expect(decryptSecret(store.getCredentialRow(SUB, "inference", "codex")!.refresh_token!)).toBe(
    "rt-old",
  );
});
