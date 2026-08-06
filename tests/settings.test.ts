import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpolate, loadConfig, resolveRef } from "../src/settings";

/** Writes a kloe.json into a fresh tmp dir and returns its path. */
function writeConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "kloe-cfg-"));
  const path = join(dir, "kloe.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

// ---- defaults & precedence ---------------------------------------------
test("an absent file yields fully-defaulted config", () => {
  const cfg = loadConfig({ path: join(tmpdir(), "does-not-exist.json"), env: {} });
  expect(cfg.server.port).toBe(3000);
  expect(cfg.server.dbPath).toBe("data/kloe.db");
  expect(cfg.blobs.backend).toBe("fs");
  expect(cfg.blobs.path).toBe("data/blobs");
  expect(cfg.blobs.s3.prefix).toBe("blobs/"); // nested section default fills
  expect(cfg.providers).toEqual([]);
});

test("file overrides defaults; env overrides the file", () => {
  const path = writeConfig({ server: { port: 4000 }, blobs: { backend: "fs" } });
  const fileOnly = loadConfig({ path, env: {} });
  expect(fileOnly.server.port).toBe(4000);

  const withEnv = loadConfig({ path, env: { PORT: "5000", KLOE_BLOB_BACKEND: "s3" } });
  expect(withEnv.server.port).toBe(5000); // env wins over file
  expect(withEnv.blobs.backend).toBe("s3");
});

// ---- validation --------------------------------------------------------
test("an invalid backend fails loudly at load", () => {
  const path = writeConfig({ blobs: { backend: "gopher" } });
  expect(() => loadConfig({ path, env: {} })).toThrow(/invalid config/);
});

test("a non-numeric PORT env is rejected by the schema", () => {
  expect(() => loadConfig({ path: "none.json", env: { PORT: "abc" } })).toThrow(/invalid config/);
});

test("malformed JSON reports which file", () => {
  const dir = mkdtempSync(join(tmpdir(), "kloe-cfg-"));
  const path = join(dir, "kloe.json");
  writeFileSync(path, "{ not json");
  try {
    expect(() => loadConfig({ path, env: {} })).toThrow(/not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- interpolation -----------------------------------------------------
test("config string values interpolate env vars", () => {
  const path = writeConfig({ blobs: { s3: { endpoint: "https://${HOST}/s3" } } });
  const cfg = loadConfig({ path, env: { HOST: "minio.home" } });
  expect(cfg.blobs.s3.endpoint).toBe("https://minio.home/s3");
});

test("provider credentials are left raw for the registry to resolve", () => {
  const path = writeConfig({ providers: [{ id: "x", apiKey: "$SECRET" }] });
  const cfg = loadConfig({ path, env: { SECRET: "shh" } });
  // Not interpolated at load — the registry resolves lazily via resolveRef.
  expect(cfg.providers[0]!.apiKey).toBe("$SECRET");
});

test("resolveRef handles $VAR, ${VAR}, defaults, and literals", () => {
  const env = { A: "one", EMPTY: "" };
  expect(resolveRef("$A", env)).toBe("one");
  expect(resolveRef("${A}", env)).toBe("one");
  expect(resolveRef("${MISSING:-fallback}", env)).toBe("fallback");
  expect(resolveRef("$MISSING", env)).toBeUndefined(); // unset, no default → undefined
  expect(resolveRef("${EMPTY:-def}", env)).toBe("def"); // empty counts as unset
  expect(resolveRef("literal", env)).toBe("literal");
});

test("interpolate substitutes embedded refs, defaulting unset to empty", () => {
  expect(interpolate("a/$B/c", { B: "x" })).toBe("a/x/c");
  expect(interpolate("a/${MISSING}/c", {})).toBe("a//c");
  expect(interpolate("a/${MISSING:-d}/c", {})).toBe("a/d/c");
});
