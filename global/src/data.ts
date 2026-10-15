// GET /data/global/<name>: the published files (CONTRACT §3.3), from R2. Only
// the manifest and part names are answered, so nothing else in the bucket
// (archive/ above all) can be reached through here.
import type { Env } from "./env";
import { DATA } from "./parts";

const PART = /^(day-\d{4}-\d{2}-\d{2}|month-\d{4}-\d{2})\.[0-9a-f]{8}\.json$/;

const notFound = () =>
  Response.json({ ok: false, error: "not-found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function serveData(req: Request, env: Env, ctx: ExecutionContext, name: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return Response.json({ ok: false, error: "method" }, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const part = PART.test(name);
  if (!part && name !== "manifest.json") return notFound();

  // A part never changes under its name, so the edge may keep it.
  const cache = caches.default;
  const get = req.method === "GET";
  if (part && get) {
    const hit = await cache.match(req);
    if (hit) return hit;
  }
  const obj = get ? await env.BUCKET.get(DATA + name) : await env.BUCKET.head(DATA + name);
  if (!obj) return notFound();
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": part ? "public, max-age=31536000, immutable" : "public, max-age=300",
    ETag: obj.httpEtag,
  });
  if (req.headers.get("if-none-match") === obj.httpEtag) return new Response(null, { status: 304, headers });
  const res = new Response(get ? (obj as R2ObjectBody).body : null, { headers });
  if (part && get) ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}
