/**
 * Generates kloe.schema.json from the valibot config schema — the single
 * source of truth. Run `bun run schema` after changing src/settings.ts so the
 * committed JSON Schema (editor autocomplete + validation for kloe.json) stays
 * in sync. `errorMode: "ignore"` tolerates the function-valued section defaults,
 * which don't serialize to JSON Schema but don't need to.
 */
import { toJsonSchema } from "@valibot/to-json-schema";
import { ConfigSchema } from "../src/settings";

const schema = toJsonSchema(ConfigSchema, { errorMode: "ignore" });
const out = new URL("../kloe.schema.json", import.meta.url);
await Bun.write(out, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${out.pathname}`);
