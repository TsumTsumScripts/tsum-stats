// GET /data/global/* from R2, and everything else to the page's files (CONTRACT §2, §3.3).
import { beforeEach, describe, expect, it } from "vitest";
import { call, env, joinNew, r2json, rollup, series, upload, wipe } from "./helpers";

beforeEach(wipe);

/** The page's files, stood in for: echoes the path it was asked for. */
const assets = { ...env, ASSETS: { fetch: async (req: Request) => new Response("asset " + new URL(req.url).pathname) } as unknown as Fetcher };

describe("published files", () => {
  it("serves the manifest and parts with their caching", async () => {
    const c = await joinNew();
    await upload(c.key, series(3));
    await rollup();
    const man = await call("/data/global/manifest.json");
    expect(man.status).toBe(200);
    expect(man.headers.get("content-type")).toBe("application/json");
    expect(man.headers.get("cache-control")).toBe("public, max-age=300");
    const m = (await man.json()) as { parts: { file: string }[] };
    expect(m).toEqual(await r2json("data/global/manifest.json"));

    const path = "/data/global/" + m.parts[0].file;
    const part = await call(path);
    expect(part.status).toBe(200);
    expect(part.headers.get("content-type")).toBe("application/json");
    expect(part.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const etag = part.headers.get("etag")!;
    expect(etag).toBeTruthy();
    expect(await part.json()).toMatchObject({ kind: "tsum-global-part" });
    // Again, from the edge cache or R2 alike.
    expect(await (await call(path)).json()).toMatchObject({ kind: "tsum-global-part" });

    const head = await call(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await call("/data/global/manifest.json", { headers: { "if-none-match": man.headers.get("etag")! } })).status).toBe(304);
    expect((await call("/data/global/manifest.json", { method: "POST", body: {} })).status).toBe(405);
  });

  it("answers 404 for anything else under /data/global, and never serves the archive", async () => {
    await env.BUCKET.put("archive/2026-10/2026-10-14/c1.json", '{"secret":true}');
    await env.BUCKET.put("data/global/notes.txt", "hello");
    for (const path of [
      "/data/global/day-2026-10-14.00000000.json", "/data/global/notes.txt", "/data/global/", "/data/global/archive/2026-10/2026-10-14/c1.json",
      "/data/global/..%2Farchive%2F2026-10%2F2026-10-14%2Fc1.json", "/data/global/day-2026-10-14.json",
    ]) {
      const res = await call(path, { env: assets });
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "not-found" });
    }
    // Outside /data/global the bucket is not reached at all.
    for (const path of ["/archive/2026-10/2026-10-14/c1.json", "/data/archive/2026-10/2026-10-14/c1.json"]) {
      expect(await (await call(path, { env: assets })).text()).toBe("asset " + path);
    }
  });

  it("hands the page's own paths to its files", async () => {
    for (const path of ["/", "/index.html", "/data/catalog.json", "/themes/midnight-felt.css", "/api"]) {
      expect(await (await call(path, { env: assets })).text()).toBe("asset " + path);
    }
    expect((await call("/api/v2/rounds", { env: assets })).status).toBe(404);
  });
});
