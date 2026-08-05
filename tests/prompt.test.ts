import { test, expect, afterEach } from "bun:test";
import type { ToolSet } from "ai";
import { renderTemplate, buildSystemPrompt } from "../src/prompt";
import { setConfig, loadConfig } from "../src/settings";

afterEach(() => setConfig(null)); // drop any test config override

test("renderTemplate substitutes fields and honors if/else", () => {
  const tpl = "Hi {{.Name}}{{if .Tag}}, {{.Tag}}{{end}}. {{if .On}}ON{{else}}OFF{{end}}";
  expect(renderTemplate(tpl, { Name: "Kloe", Tag: "bot", On: true })).toBe("Hi Kloe, bot. ON");
  expect(renderTemplate(tpl, { Name: "Kloe", Tag: "", On: false })).toBe("Hi Kloe. OFF");
});

test("renderTemplate ranges over a list binding the dot", () => {
  const tpl = "{{range .Files}}<{{.Path}}:{{.Content}}>{{end}}";
  const out = renderTemplate(tpl, { Files: [{ Path: "a", Content: "1" }, { Path: "b", Content: "2" }] });
  expect(out).toBe("<a:1><b:2>");
});

test("renderTemplate strips comments and treats empty list as falsey", () => {
  const tpl = "{{/* a comment */}}A{{if .Xs}}has{{end}}B";
  expect(renderTemplate(tpl, { Xs: [] })).toBe("AB");
  expect(renderTemplate(tpl, { Xs: [1] })).toBe("AhasB");
});

function cfg(prompt: Record<string, unknown>): void {
  const base = loadConfig({ path: "/nonexistent", env: {} }); // schema defaults only
  setConfig({ ...base, prompt: { ...base.prompt, ...prompt } });
}

test("buildSystemPrompt includes the date and a tools section only when tools exist", () => {
  cfg({});
  const now = new Date("2026-08-04T12:00:00Z");
  const noTools = buildSystemPrompt({ tools: {} as ToolSet, now });
  expect(noTools).toContain("August 4, 2026");
  expect(noTools).not.toContain("<tools>");

  const withTools = buildSystemPrompt({
    tools: { web_search: { description: "Search the web." } } as unknown as ToolSet,
    now,
  });
  expect(withTools).toContain("<tools>");
  expect(withTools).toContain("web_search: Search the web.");
});

test("buildSystemPrompt renders configured persona and drops emoji when asked", () => {
  cfg({ name: "Nova", personality: "Terse and precise.", noEmoji: true });
  const out = buildSystemPrompt({ tools: {} as ToolSet, now: new Date("2026-08-04") });
  expect(out).toContain("You are Nova.");
  expect(out).toContain("Terse and precise.");
  expect(out).toContain("Skip emoji");
});
