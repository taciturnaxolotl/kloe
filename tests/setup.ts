// Hermetic tests: never read the developer's kloe.json. Point config resolution
// at a path that doesn't exist so getConfig()/loadConfig() always fall back to
// schema defaults (auth disabled, no providers) — even after a test does
// setConfig(null), which forces a reload from disk. Tests that need specific
// config set it explicitly via setConfig / loadConfig({ path, env }).
process.env.KLOE_CONFIG = "/nonexistent-kloe-test-config.json";
// Default any Store() to an in-memory DB so tests never touch data/kloe.db on
// disk (tests that want a shared/real path still pass one explicitly).
process.env.KLOE_DB = ":memory:";
