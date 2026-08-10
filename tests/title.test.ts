import { expect, test } from "bun:test";
import { Store } from "../src/store";
import { sanitize } from "../src/title";

type RawDb = { db: { query: (s: string) => { run: (...a: unknown[]) => void } } };

function seedUser(store: Store, id: string, content: string, attachments?: unknown[]): void {
  const db = (store as unknown as RawDb).db;
  db.query("INSERT INTO conversations (id, created_at, last_seq) VALUES (?, ?, 0)").run(
    id,
    Date.now(),
  );
  db.query(
    "INSERT INTO events (id, conversation_id, seq, event, data, created_at) VALUES (?, ?, 0, 'user-message', ?, ?)",
  ).run(`${id}:0`, id, JSON.stringify({ content, attachments }), Date.now());
}

/** Append assistant text-deltas after the seeded opener. */
function seedReply(store: Store, id: string, ...deltas: string[]): void {
  const db = (store as unknown as RawDb).db;
  deltas.forEach((delta, i) => {
    const seq = i + 1;
    db.query(
      "INSERT INTO events (id, conversation_id, seq, event, data, created_at) VALUES (?, ?, ?, 'text-delta', ?, ?)",
    ).run(`${id}:${seq}`, id, seq, JSON.stringify({ delta }), Date.now());
  });
}

test("firstUserMessage returns the first user prompt", () => {
  const store = new Store(":memory:");
  seedUser(store, "c1", "how do spherical mirrors work?");
  expect(store.firstUserMessage("c1")).toBe("how do spherical mirrors work?");
  expect(store.firstUserMessage("nope")).toBeNull();
});

test("sanitize strips the wrapping small models add", () => {
  expect(sanitize("Spherical Mirror Optics")).toBe("Spherical Mirror Optics");
  expect(sanitize('"Spherical Mirror Optics"')).toBe("Spherical Mirror Optics");
  expect(sanitize("Title: Spherical Mirror Optics")).toBe("Spherical Mirror Optics");
  expect(sanitize('"Title: Spherical Mirror Optics"')).toBe("Spherical Mirror Optics");
  expect(sanitize("**Spherical Mirror Optics.**")).toBe("Spherical Mirror Optics");
  expect(sanitize("Spherical Mirror Optics\nand some rambling")).toBe("Spherical Mirror Optics");
  expect(sanitize("   ")).toBe("");
});

test("sanitize truncates a title that ran long", () => {
  const out = sanitize("word ".repeat(40));
  expect(out.length).toBeLessThanOrEqual(71);
  expect(out.endsWith("…")).toBe(true);
});

test("titleSeed carries the reply, so a one-word opener still has a subject", () => {
  const store = new Store(":memory:");
  seedUser(store, "c1", "hi");
  seedReply(store, "c1", "Spherical mirrors ", "focus light to a point.");
  const seed = store.titleSeed("c1")!;
  expect(seed).toContain("User: hi");
  expect(seed).toContain("Assistant: Spherical mirrors focus light to a point.");
});

test("titleSeed names the files when the opener is attachments only", () => {
  const store = new Store(":memory:");
  seedUser(store, "c1", "", [{ sha256: "a", name: "budget.csv", mime: "text/csv", kind: "file" }]);
  expect(store.titleSeed("c1")).toContain("budget.csv");
});

test("titleSeed is null for a conversation with nothing in it", () => {
  const store = new Store(":memory:");
  expect(store.titleSeed("nope")).toBeNull();
});

test("titleSeed caps the reply it carries", () => {
  const store = new Store(":memory:");
  seedUser(store, "c1", "go");
  seedReply(store, "c1", "x".repeat(5000));
  expect(store.titleSeed("c1")!.length).toBeLessThan(2500);
});

test("setTitleIfEmpty sets a title, then never clobbers it", () => {
  const store = new Store(":memory:");
  seedUser(store, "c1", "hi");
  expect(store.hasCustomTitle("c1")).toBe(false);

  expect(store.setTitleIfEmpty("c1", "Spherical Mirrors")).toBe(true);
  expect(store.hasCustomTitle("c1")).toBe(true);
  expect(store.listConversations().find((c) => c.id === "c1")?.title).toBe("Spherical Mirrors");

  // A second auto-title (or a race) must not overwrite an existing title.
  expect(store.setTitleIfEmpty("c1", "Something Else")).toBe(false);
  expect(store.listConversations().find((c) => c.id === "c1")?.title).toBe("Spherical Mirrors");
});

test("a user rename wins and blocks auto-titling", () => {
  const store = new Store(":memory:");
  seedUser(store, "c1", "hi");
  store.renameConversation("c1", "My Own Title");
  expect(store.hasCustomTitle("c1")).toBe(true);
  expect(store.setTitleIfEmpty("c1", "Auto Title")).toBe(false); // rename is untouched
  expect(store.listConversations().find((c) => c.id === "c1")?.title).toBe("My Own Title");
});

test("setTitleIfEmpty ignores a blank title", () => {
  const store = new Store(":memory:");
  seedUser(store, "c1", "hi");
  expect(store.setTitleIfEmpty("c1", "   ")).toBe(false);
  expect(store.hasCustomTitle("c1")).toBe(false);
});
