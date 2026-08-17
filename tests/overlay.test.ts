import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleCan, roleFor } from "../src/auth";
import { loadConfig, overlayAllows, readOverlay, setConfig, writeOverlay } from "../src/settings";

/**
 * The overlay: the half of the config an owner changes by clicking, kept in a
 * file beside the database rather than in the nix store, which is read-only.
 *
 * The tests that matter are about the boundary between the two halves. A
 * running server writes this file on the strength of a session cookie, so what
 * it may NOT write is the part worth being sure about.
 */

// The directories themselves, so cleanup removes what was created and nothing
// above it.
const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "kloe-overlay-"));
  dirs.push(d);
  return d;
}
const tmp = (): string => join(tmpDir(), "overrides.json");
afterEach(() => {
  setConfig(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("policy the UI owns can be written; anything else is refused", () => {
  const path = tmp();

  // Role policy is the point of the thing.
  writeOverlay({ auth: { roles: { staff: { sandbox: true } } } }, path);
  expect(readOverlay(path)).toEqual({ auth: { roles: { staff: { sandbox: true } } } });

  // Who may sign in, and every secret, stay declared in nix — where a change is
  // a diff somebody reviews rather than a click on a running server.
  for (const forbidden of [
    { auth: { owners: ["https://attacker/"] } },
    { auth: { allowedSubs: [] } },
    { auth: { clientSecret: "iks_x" } },
    { security: { credentialKey: "hunter2" } },
    { providers: [{ id: "evil", apiEndpoint: "https://evil.test/v1" }] },
    { server: { port: 9999 } },
  ]) {
    expect(() => writeOverlay(forbidden, path)).toThrow(/cannot be changed from here/);
  }
  // …and the refusal wrote nothing.
  expect(readOverlay(path)).toEqual({ auth: { roles: { staff: { sandbox: true } } } });
});

test("the overlay wins over what nix declared, for the paths it owns", () => {
  const dir = tmpDir();
  const path = join(dir, "overrides.json");
  const declared = join(dir, "kloe.json");
  writeFileSync(
    declared,
    JSON.stringify({ auth: { enabled: true, roles: { staff: { sandbox: false } } } }),
  );

  const before = loadConfig({ path: declared, env: {}, overlay: {} });
  setConfig(before);
  expect(roleFor("https://a/", "staff")).toBe("staff");
  expect(roleCan("staff", "sandbox")).toBe(false);

  const after = loadConfig({
    path: declared,
    env: {},
    overlay: { auth: { roles: { staff: { sandbox: true } } } },
  });
  setConfig(after);
  expect(roleCan("staff", "sandbox")).toBe(true);
});

test("a patch merges rather than replacing what is already there", () => {
  const path = tmp();
  writeOverlay({ auth: { roles: { staff: { sandbox: true } } } }, path);
  writeOverlay({ prompt: { name: "Kloe" } }, path);
  // Editing the persona must not quietly drop a role's policy.
  expect(readOverlay(path)).toEqual({
    auth: { roles: { staff: { sandbox: true } } },
    prompt: { name: "Kloe" },
  });
});

test("the file is written to be read: sorted, indented, newline-terminated", () => {
  const path = tmp();
  writeOverlay({ prompt: { tagline: "b", name: "a" } }, path);
  const text = readFileSync(path, "utf8");
  expect(text).toBe('{\n  "prompt": {\n    "name": "a",\n    "tagline": "b"\n  }\n}\n');
});

test("an unreadable overlay is ignored, not fatal", () => {
  const path = tmp();
  writeFileSync(path, "{ this is not json");
  // The declared config is a complete deployment on its own; a corrupt overlay
  // must not be the thing that stops the server booting.
  expect(readOverlay(path)).toEqual({});
});

test("overlayAllows draws the line where the paths do", () => {
  expect(overlayAllows("auth.roles")).toBe(true);
  expect(overlayAllows("auth.roles.staff.sandbox")).toBe(true);
  expect(overlayAllows("prompt.name")).toBe(true);
  expect(overlayAllows("research.maxAgents")).toBe(true);
  expect(overlayAllows("auth.owners")).toBe(false);
  expect(overlayAllows("auth.rolesomething")).toBe(false);
  expect(overlayAllows("providers")).toBe(false);
});
