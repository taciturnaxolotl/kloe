export const BATCH_MAX_DELTAS = 16;
export const BATCH_FLUSH_MS = 50;
export const HEARTBEAT_INTERVAL_MS = 10_000;
// Grace must exceed the heartbeat interval so a healthy run isn't reaped
// between beats. 30s gives ~3 missed heartbeats of headroom.
export const LEASE_GRACE_MS = 30_000;
export const REAP_INTERVAL_MS = 5_000;
export const SUBSCRIBER_HEARTBEAT_MS = 15_000;
export const MAX_SSE_FIELD_BYTES = 8 * 1024;
// Actors with no subscribers and no active run are evicted after this TTL.
export const ACTOR_IDLE_TTL_MS = 5 * 60_000;
