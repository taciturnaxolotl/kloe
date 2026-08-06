import { test, expect } from "bun:test";
import { Store } from "../src/store";

function seedUser(store: Store, id: string, content: string): void {
  const db = (store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }).db;
  db.query("INSERT INTO conversations (id, created_at, last_seq) VALUES (?, ?, 0)").run(id, Date.now());
  db.query("INSERT INTO events (id, conversation_id, seq, event, data, created_at) VALUES (?, ?, 0, 'user-message', ?, ?)")
    .run(`${id}:0`, id, JSON.stringify({ content }), Date.now());
}

test("firstUserMessage returns the first user prompt", () => {
  const store = new Store(":memory:");
  seedUser(store, "c1", "how do spherical mirrors work?");
  expect(store.firstUserMessage("c1")).toBe("how do spherical mirrors work?");
  expect(store.firstUserMessage("nope")).toBeNull();
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
