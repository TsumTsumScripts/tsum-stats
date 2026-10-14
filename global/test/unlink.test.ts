// POST /api/v1/me/unlink and step 3 of the hourly job (CONTRACT §2.4).
import { beforeEach, describe, expect, it } from "vitest";
import { archiveKey } from "../src/archive";
import { hex48, keyDay, keyDaySQL } from "../src/days";
import { DAY_MS, NOW, admin, call, env, joinNew, json, one, r2json, r2keys, record, rollup, rows, series, upload, wipe } from "./helpers";
import { checkAgainstReference, tables } from "./reference";

beforeEach(wipe);

const LATER = NOW + 62 * DAY_MS;

describe("unlink", () => {
  it("stops the key at once and re-files the rounds under contributor 0 in chunks", async () => {
    const a = await joinNew(), b = await joinNew();
    await upload(a.key, [...series(6, { tag: "0a0000000001" }), ...series(4, { tag: "0a0000000002", end: NOW - 1800_000 })]);
    await upload(b.key, series(3, { tag: "0b0000000001" }));
    await rollup();
    const before = await tables();
    const keys = await rows("SELECT key FROM rounds ORDER BY key");

    const res = await call("/api/v1/me/unlink", { method: "POST", key: a.key });
    expect(await res.json()).toEqual({ ok: true });
    expect((await call("/api/v1/me", { key: a.key })).status).toBe(401);
    expect((await upload(a.key, series(1))).status).toBe(401);
    expect(await one("SELECT key_hash, status FROM contributors WHERE id = ?1", a.id)).toEqual({ key_hash: null, status: "unlinking" });
    expect(await one("SELECT count(*) AS n FROM devices WHERE contributor = ?1", a.id)).toEqual({ n: 0 });
    expect(await one("SELECT count(*) AS n FROM contrib_cells WHERE contributor = ?1", a.id)).toEqual({ n: 0 });
    expect(await one("SELECT count(*) AS n FROM state WHERE key = 'span:' || ?1", a.id)).toEqual({ n: 0 });

    const small = { ...env, UNLINK_CHUNK: "4" };
    const left: number[] = [];
    for (let i = 0; i < 5; i++) {
      const [r] = await rollup(NOW, small, 1);
      left.push((await one<{ n: number }>("SELECT count(*) AS n FROM rounds WHERE contributor = ?1", a.id)).n);
      if (r.unlinked.length) {
        expect(r.unlinked).toEqual([a.id]);
        break;
      }
    }
    expect(left).toEqual([6, 2, 0]);
    expect(await one("SELECT count(*) AS n FROM contributors WHERE id = ?1", a.id)).toEqual({ n: 0 });
    expect(await one("SELECT count(*) AS n FROM state WHERE key = 'unlink:' || ?1", a.id)).toEqual({ n: 0 });
    // The rounds stay, with their keys (and so their device hashes), under contributor 0.
    expect(await rows("SELECT key FROM rounds ORDER BY key")).toEqual(keys);
    expect(await one("SELECT count(*) AS n FROM rounds WHERE contributor = 0")).toEqual({ n: 10 });

    await rollup();
    const after = await tables();
    expect(after.cells).toEqual(before.cells);
    expect(after.bins).toEqual(before.bins);
    expect(after.contrib).toEqual(before.contrib.filter(c => c.contributor !== a.id));
    await checkAgainstReference(new Set());
    expect((await r2json<{ contributors: number; rounds: number }>("data/global/manifest.json"))).toMatchObject({ contributors: 1, rounds: 13 });
  });

  it("marks the days its rounds started dirty as it re-files them", async () => {
    const a = await joinNew();
    const midnight = Date.UTC(2026, 9, 13);
    await upload(a.key, [
      // Began just before midnight and ended hours into the next day.
      record({ at: midnight + 2 * 3600_000, took: 2 * 3600 + 30, duration: 2 * 3600 }),
      record({ at: NOW - 3600_000 }),
    ]);
    await rollup();
    await call("/api/v1/me/unlink", { method: "POST", key: a.key });
    // The re-filing comes after the recompute in a run, so its days wait for the next.
    await rollup(NOW, env, 1);
    expect((await rows("SELECT day FROM dirty_days ORDER BY day")).map(r => r.day)).toEqual(["2026-10-12", "2026-10-14"]);

    // keyDay in SQL, at the edges of a day.
    for (const ms of [0, midnight - 1, midnight, midnight + DAY_MS - 1, Date.UTC(2100, 0, 1) - 1]) {
      const key = hex48(ms) + "7abc8def" + "0".repeat(12);
      expect((await one<{ d: string }>(`SELECT ${keyDaySQL("?1")} AS d`, key)).d, key).toBe(keyDay(key));
    }
  });

  it("keeps a recompute from bringing an unlinking contributor's record back", async () => {
    const a = await joinNew();
    await upload(a.key, series(6));
    await rollup();
    await call("/api/v1/me/unlink", { method: "POST", key: a.key });
    await admin("rebuild", {});
    // The rebuild runs before the re-filing in the same run.
    await rollup(NOW, { ...env, UNLINK_CHUNK: "2" }, 1);
    expect(await one("SELECT count(*) AS n FROM contrib_cells")).toEqual({ n: 0 });
    expect(await one("SELECT sum(rounds) AS n FROM cells")).toEqual({ n: 6 });
  });

  it("renames its archive files so no file names it", async () => {
    const a = await joinNew(), b = await joinNew();
    const mine = series(5, { tag: "0a0000000001" });
    await upload(a.key, mine);
    await upload(b.key, series(3, { tag: "0b0000000001" }));
    await rollup();
    await rollup(LATER);
    const day = "2026-10-14";
    const named = (await r2json<{ key: string[]; contributor: number }>(archiveKey(day, `c${a.id}.json`)))!;
    expect(named.contributor).toBe(a.id);

    expect((await call("/api/v1/me/unlink", { method: "POST", key: a.key, now: LATER })).status).toBe(200);
    const [r] = await rollup(LATER);
    expect(r.unlinked).toEqual([a.id]);
    const files = await r2keys(archiveKey(day, ""));
    expect(files).not.toContain(archiveKey(day, `c${a.id}.json`));
    expect(files).toContain(archiveKey(day, `c${b.id}.json`));
    const renamed = files.filter(f => f.slice(f.lastIndexOf("/") + 1).startsWith("u"));
    expect(renamed).toHaveLength(1);
    const u = (await r2json<{ key: string[]; contributor: number | null; n: number }>(renamed[0]))!;
    expect(u.contributor).toBeNull();
    expect(u.key).toEqual(named.key);
    expect(JSON.stringify(u)).not.toContain(`"contributor":${a.id}`);

    // Restored, the rounds are contributor 0's.
    await admin("restore", { day }, LATER);
    expect(await rows("SELECT contributor, count(*) AS n FROM rounds GROUP BY contributor ORDER BY contributor"))
      .toEqual([{ contributor: 0, n: 5 }, { contributor: b.id, n: 3 }]);
  });

  it("deletes a banned contributor's rounds instead", async () => {
    const a = await joinNew(), b = await joinNew();
    await upload(a.key, series(7, { tag: "0a0000000001" }));
    await upload(b.key, series(3, { tag: "0b0000000001" }));
    await admin("ban", { id: a.id });
    await rollup();
    const before = await tables();
    expect(await json(call("/api/v1/me/unlink", { method: "POST", key: a.key }))).toEqual({ ok: true });
    expect(await one("SELECT status FROM contributors WHERE id = ?1", a.id)).toEqual({ status: "unlinking-banned" });
    const reports = await rollup(NOW, { ...env, UNLINK_CHUNK: "3" });
    expect(reports.flatMap(r => r.unlinked)).toEqual([a.id]);
    expect(await rows("SELECT contributor, count(*) AS n FROM rounds GROUP BY contributor")).toEqual([{ contributor: b.id, n: 3 }]);
    expect(await one("SELECT count(*) AS n FROM contributors WHERE id = ?1", a.id)).toEqual({ n: 0 });
    await admin("rebuild", {});
    await rollup();
    expect((await tables()).cells).toEqual(before.cells);
  });

  it("archives an unlinking contributor's rounds unnamed", async () => {
    const a = await joinNew();
    await upload(a.key, series(4));
    await rollup();
    // Unlinked just as its day becomes final, with the re-filing not yet done.
    await call("/api/v1/me/unlink", { method: "POST", key: a.key, now: LATER });
    await rollup(LATER, { ...env, UNLINK_CHUNK: "1" }, 1);
    const files = await r2keys(archiveKey("2026-10-14", ""));
    expect(files.some(f => f.endsWith(`/c${a.id}.json`))).toBe(false);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect((await r2json<{ contributor: number | null }>(f))!.contributor).toBeNull();
    const all = await Promise.all(files.map(f => r2json<{ n: number }>(f)));
    expect(all.reduce((n, f) => n + f!.n, 0)).toBe(4);
  });
});
