import type { BlobStore } from "./blobs";
import type { Store } from "./store";

/**
 * The public face of a published document.
 *
 * These routes live in their own module, and are registered in server.ts beside
 * the auth handlers rather than inside `apiRoutes`, because everything under
 * `/api` is wrapped by `gateApi` and must stay that way. Public endpoints are a
 * different trust domain, so they get a different door: nothing here reads a
 * session, and nothing here can be reached by editing a conversation id.
 *
 * A token is a capability. It is the only input, it resolves to exactly one
 * publication row, and that row already carries the bytes' address — so a
 * request that guesses wrong can't fall through to a conversation's documents,
 * because this path never queries them.
 */
export function shareRoutes(deps: { store: Store; blobs: BlobStore }) {
  const { store, blobs } = deps;
  // Tokens are hex UUIDs; anything else is rejected before it reaches SQL.
  const isToken = (t: string) => /^[0-9a-f]{32}$/.test(t);

  return {
    // What the share page needs to render itself: the title, the type, and how
    // big it is. Deliberately NOT the conversation it came from — a reader of a
    // shared document learns about the document and nothing else.
    "/api/public/:token": {
      GET: (req: Bun.BunRequest<"/api/public/:token">) => {
        const p = isToken(req.params.token) ? store.getPublication(req.params.token) : null;
        if (!p) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(
          {
            name: p.name,
            title: p.title,
            mime: p.mime,
            size: p.size,
            version: p.version,
            createdAt: p.createdAt,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },

    // The bytes themselves. Same defanging as the private blob route: model- and
    // upload-authored bytes served from our own origin, so anything a browser
    // would run script from is dropped into an opaque origin with scripting off.
    // The share page renders HTML deliberately, in a sandboxed frame of its own
    // making — never by pointing the browser straight at this URL.
    "/api/public/:token/raw": {
      GET: async (req: Bun.BunRequest<"/api/public/:token/raw">) => {
        const p = isToken(req.params.token) ? store.getPublication(req.params.token) : null;
        if (!p) return new Response("not found", { status: 404 });
        const bytes = await blobs.get(p.sha256);
        if (!bytes) return new Response("not found", { status: 404 });
        const headers: Record<string, string> = {
          "Content-Type": p.mime,
          "Content-Disposition": `inline; filename="${p.name.replace(/[^\w.\- ]+/g, "_").slice(0, 128)}"`,
          "X-Content-Type-Options": "nosniff",
          // The token pins one version's bytes, so the response is immutable —
          // but unpublishing has to take effect, so revalidate rather than cache
          // a revoked document in a reader's browser for a year.
          "Cache-Control": "no-cache",
        };
        if (ACTIVE_MIME.test(p.mime)) headers["Content-Security-Policy"] = "sandbox";
        return new Response(bytes, { headers });
      },
    },
  };
}

/** Mimes a browser will execute script from when it renders them as a document. */
const ACTIVE_MIME =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|(?:text|application)\/xml)\b/i;
