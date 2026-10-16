// POST /api/v1/me/unlink and step 3 of the hourly job (CONTRACT §2.4).
import { beforeEach, describe, expect, it } from "vitest";
import { archiveKey } from "../src/archive";
import { authContributor } from "../src/contributors";
import { postRounds } from "../src/ingest";
import { DAY_MS, NOW, admin, batch, call, env, joinNew, json, one, r2json, r2keys, record, rollup, rows, series, upload, wipe } from "./helpers";
import { checkAgainstReference, counted, tables } from "./reference";

beforeEach(wipe);

const LATER = NOW + 62 * DAY_MS;
/** Drops archived days at once, so a restore reads them back from their files. */
const DROP = { ...env, RETAIN_ROWS: "0" };
const unlink = (key: string, now = NOW) => call("/api/v1/me/unlink", { method: "POST", body: {}, key, now });
const named = (files: string[], id: number) => files.filter(f => new RegExp(`/c${id}\\.`).test(f));

describe("unlink", () => {
  it("stops the key at once and re-files the rounds under contributor 0, a day at a time", async () => {
    const a = await joinNew(NOW - 3 * DAY_MS), b = await joinNew();
    await upload(a.key, [
      ...series(3, { tag: "0a0000000001", end: NOW - 2 * DAY_MS }),
      ...series(4, { tag: "0a0000000002", end: NOW - DAY_MS }),
      ...series(5, { tag: "0a0000000001" }),
    ]);
    await upload(b.key, series(3, { tag: "0b0000000001" }));
    await rollup();
    const before = await tables();
    const keys = await rows("SELECT key FROM rounds ORDER BY key");

    const res = await unlink(a.key);
    expect(await res.json()).toEqual({ ok: true });
    expect((await call("/api/v1/me", { key: a.key })).status).toBe(401);
    expect((await upload(a.key, series(1))).status).toBe(401);
    expect(await one("SELECT key_hash, status FROM contributors WHERE id = ?1", a.id)).toEqual({ key_hash: null, status: "unlinking" });
    expect(await one("SELECT count(*) AS n FROM devices WHERE contributor = ?1", a.id)).toEqual({ n: 0 });
    expect(await one("SELECT count(*) AS n FROM contrib_cells WHERE contributor = ?1", a.id)).toEqual({ n: 0 });
    expect(await one("SELECT count(*) AS n FROM state WHERE key = ?1", "span:" + a.id)).toEqual({ n: 0 });
    expect(JSON.parse((await one<{ value: string }>("SELECT value FROM state WHERE key = ?1", "unlink:" + a.id)).value))
      .toEqual({ days: [["2026-10-12", 3], ["2026-10-13", 4], ["2026-10-14", 5]], ids: [a.id] });

    const small = { ...env, UNLINK_CHUNK: "1" };
    const left: number[] = [];
    for (let i = 0; i < 5; i++) {
      const [r] = await rollup(NOW, small, 1);
      left.push((await one<{ n: number }>("SELECT count(*) AS n FROM rounds WHERE contributor = ?1", a.id)).n);
      // Re-filing changes no public figure: nothing is recomputed for it.
      expect(r.recomputed).toEqual([]);
      expect(await one("SELECT count(*) AS n FROM dirty_days")).toEqual({ n: 0 });
      if (r.unlinked.length) {
        expect(r.unlinked).toEqual([a.id]);
        break;
      }
    }
    expect(left).toEqual([9, 5, 0]);
    expect(await one("SELECT count(*) AS n FROM contributors WHERE id = ?1", a.id)).toEqual({ n: 0 });
    expect(await one("SELECT count(*) AS n FROM state WHERE key = ?1", "unlink:" + a.id)).toEqual({ n: 0 });
    // The rounds stay, with their keys (and so their device hashes), under contributor 0.
    expect(await rows("SELECT key FROM rounds ORDER BY key")).toEqual(keys);
    expect(await one("SELECT count(*) AS n FROM rounds WHERE contributor = 0")).toEqual({ n: 12 });

    const after = await tables();
    expect(after.cells).toEqual(before.cells);
    expect(after.bins).toEqual(before.bins);
    expect(after.contrib).toEqual(before.contrib.filter(c => c.contributor !== a.id));
    await admin("rebuild", {});
    await rollup();
    await checkAgainstReference(new Set());
    expect((await r2json<{ contributors: number; rounds: number }>("data/global/manifest.json"))).toMatchObject({ contributors: 1, rounds: 15 });
  });

  it("marks no day dirty, and reads each of its days once, not the whole rounds table", async () => {
    const a = await joinNew(), b = await joinNew();
    const midnight = Date.UTC(2026, 9, 13);
    await upload(a.key, [
      // Began just before midnight and ended hours into the next day: its day is the 12th.
      record({ at: midnight + 2 * 3600_000, took: 2 * 3600 + 30, duration: 2 * 3600 }),
      record({ at: NOW - 3600_000 }),
    ]);
    // Others' rounds: on its day, which the unlink reads, and on eight other days, which it does not.
    for (let d = 0; d <= 8; d++) {
      const end = d === 0 ? NOW - 2 * 3600_000 : NOW - (d + 2) * DAY_MS;
      await upload(b.key, Array.from({ length: 200 }, (_, i) => record({ at: end - i * 45_000, tag: `0b00000000${String(d).padStart(2, "0")}` })));
    }
    await rollup();
    const before = await tables();
    await unlink(a.key);
    const k = counted();
    const [r] = await rollup(NOW, k.env);
    expect(r.unlinked).toEqual([a.id]);
    expect(r.recomputed).toEqual([]);
    expect(await one("SELECT count(*) AS n FROM dirty_days")).toEqual({ n: 0 });
    expect(await tables()).toEqual({ ...before, contrib: before.contrib.filter(c => c.contributor !== a.id) });
    const refile = [...k.n.bySql].filter(([sql]) => sql.startsWith("UPDATE rounds SET contributor = 0"));
    expect(refile.map(([, e]) => e.written)).toEqual([2]);
    // Its two days hold 202 rounds; the table holds 1,802.
    const read = refile.reduce((n, [, e]) => n + e.read, 0);
    expect(read).toBeGreaterThanOrEqual(202);
    expect(read).toBeLessThan(250);
  });

  it("keeps a recompute from bringing an unlinking contributor's record back", async () => {
    const a = await joinNew();
    await upload(a.key, series(6));
    await rollup();
    await unlink(a.key);
    await admin("rebuild", {});
    // The rebuild runs before the re-filing in the same run.
    await rollup(NOW, { ...env, UNLINK_CHUNK: "2" }, 1);
    expect(await one("SELECT count(*) AS n FROM contrib_cells")).toEqual({ n: 0 });
    expect(await one("SELECT sum(rounds) AS n FROM cells2")).toEqual({ n: 6 });
  });

  it("stores nothing of an upload whose key was checked just before the unlink", async () => {
    const a = await joinNew();
    await upload(a.key, series(3, { end: NOW - 2 * 3600_000 }));
    // The upload's key is checked, then the unlink lands before its batch does.
    const late = await authContributor(new Request("https://x/", { headers: { authorization: "Bearer " + a.key } }), env);
    await unlink(a.key);
    const req = new Request("https://tsum-stats.gapscripts.app/api/v1/rounds", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch(series(4, { tag: "0a0000000009" }))),
    });
    await expect(postRounds(req, env, late, NOW)).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(await one("SELECT count(*) AS n FROM devices")).toEqual({ n: 0 });
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 3 });
    const [r] = await rollup();
    expect(r.unlinked).toEqual([a.id]);
    expect(await rows("SELECT DISTINCT contributor FROM rounds")).toEqual([{ contributor: 0 }]);
    expect(await one("SELECT count(*) AS n FROM devices")).toEqual({ n: 0 });
  });

  it("renames its archive files so no file names it", async () => {
    const a = await joinNew(), b = await joinNew();
    const mine = series(5, { tag: "0a0000000001" });
    await upload(a.key, mine);
    await upload(b.key, series(3, { tag: "0b0000000001" }));
    await rollup();
    await rollup(LATER, DROP);
    const day = "2026-10-14";
    const file = (await r2json<{ key: string[]; contributor: number }>(archiveKey(day, `c${a.id}.json`)))!;
    expect(file.contributor).toBe(a.id);

    expect((await unlink(a.key, LATER)).status).toBe(200);
    const [r] = await rollup(LATER, DROP);
    expect(r.unlinked).toEqual([a.id]);
    const files = await r2keys(archiveKey(day, ""));
    expect(named(files, a.id)).toEqual([]);
    expect(files).toContain(archiveKey(day, `c${b.id}.json`));
    const renamed = files.filter(f => f.slice(f.lastIndexOf("/") + 1).startsWith("u"));
    expect(renamed).toHaveLength(1);
    const u = (await r2json<{ key: string[]; contributor: number | null; n: number }>(renamed[0]))!;
    expect(u.contributor).toBeNull();
    expect(u.key).toEqual(file.key);
    expect(JSON.stringify(u)).not.toContain(`"contributor":${a.id}`);

    // Restored, the rounds are contributor 0's.
    await admin("restore", { day }, LATER);
    expect(await rows("SELECT contributor, count(*) AS n FROM rounds GROUP BY contributor ORDER BY contributor"))
      .toEqual([{ contributor: 0, n: 5 }, { contributor: b.id, n: 3 }]);
  });

  it("renames the files of ids merged into it, and those of days archived under a shorter ACCEPT_DAYS", async () => {
    const a = await joinNew(), b = await joinNew(), c = await joinNew();
    await upload(a.key, series(4, { tag: "0a0000000001" }));
    await upload(b.key, series(2, { tag: "0b0000000001" }));
    await upload(c.key, series(3, { tag: "0c0000000001" }));
    await rollup();
    await rollup(LATER, DROP);
    const day = "2026-10-14";
    expect(named(await r2keys(archiveKey(day, "")), a.id)).toHaveLength(1);
    // a is b's second install; then b leaves, under a longer ACCEPT_DAYS than the day was archived with.
    await admin("merge", { from: a.id, into: b.id }, LATER);
    const longer = { ...DROP, ACCEPT_DAYS: "90" };
    await call("/api/v1/me/unlink", { body: {}, key: b.key, now: LATER, env: longer });
    const [r] = await rollup(LATER, longer);
    expect(r.unlinked).toEqual([b.id]);
    const files = await r2keys(archiveKey(day, ""));
    expect(named(files, a.id)).toEqual([]);
    expect(named(files, b.id)).toEqual([]);
    expect(named(files, c.id)).toHaveLength(1);
    for (const f of files.filter(f => !f.includes(`/c${c.id}.`))) expect((await r2json<{ contributor: unknown }>(f))!.contributor).toBeNull();
    expect(await one("SELECT count(*) AS n FROM state WHERE key = ?1", "merged:" + a.id)).toEqual({ n: 0 });
    // A restore files them all as no one's.
    await admin("restore", { day }, LATER);
    expect(await rows("SELECT contributor, count(*) AS n FROM rounds GROUP BY contributor ORDER BY contributor"))
      .toEqual([{ contributor: 0, n: 6 }, { contributor: c.id, n: 3 }]);
  });

  it("deletes a banned contributor's rounds instead", async () => {
    const a = await joinNew(), b = await joinNew();
    await upload(a.key, series(7, { tag: "0a0000000001" }));
    await upload(b.key, series(3, { tag: "0b0000000001" }));
    await admin("ban", { id: a.id });
    await rollup();
    const before = await tables();
    expect(await json(unlink(a.key))).toEqual({ ok: true });
    expect(await one("SELECT status FROM contributors WHERE id = ?1", a.id)).toEqual({ status: "unlinking-banned" });
    const reports = await rollup(NOW, { ...env, UNLINK_CHUNK: "3" });
    expect(reports.flatMap(r => r.unlinked)).toEqual([a.id]);
    expect(await rows("SELECT contributor, count(*) AS n FROM rounds GROUP BY contributor")).toEqual([{ contributor: b.id, n: 3 }]);
    expect(await one("SELECT count(*) AS n FROM contributors WHERE id = ?1", a.id)).toEqual({ n: 0 });
    await admin("rebuild", {});
    await rollup();
    expect((await tables()).cells).toEqual(before.cells);
  });

  it("keeps a banned contributor's rounds out of the public figures after it unlinks, through a restore", async () => {
    const a = await joinNew(), b = await joinNew();
    await upload(a.key, series(7, { tag: "0a0000000001" }));
    await upload(b.key, series(3, { tag: "0b0000000001" }));
    await admin("ban", { id: a.id });
    await rollup();
    expect(await one("SELECT sum(rounds) AS n FROM cells2")).toEqual({ n: 3 });
    // Its day is archived as c<a>.json, then a leaves.
    await rollup(LATER, DROP);
    const day = "2026-10-14";
    expect(named(await r2keys(archiveKey(day, "")), a.id)).toHaveLength(1);
    await unlink(a.key, LATER);
    const [r] = await rollup(LATER, DROP);
    expect(r.unlinked).toEqual([a.id]);
    const files = await r2keys(archiveKey(day, ""));
    // Its rounds are kept, in a b file nothing ever reads back.
    expect(named(files, a.id)).toEqual([]);
    const kept = files.filter(f => f.slice(f.lastIndexOf("/") + 1).startsWith("b"));
    expect(kept).toHaveLength(1);
    expect((await r2json<{ contributor: unknown; n: number }>(kept[0]))).toMatchObject({ contributor: null, n: 7 });
    expect(await one("SELECT value FROM state WHERE key = ?1", "gone:" + a.id)).toEqual({ value: "banned" });

    const restored = await json(admin("restore", { day }, LATER));
    expect(restored).toMatchObject({ done: true, rounds: 3 });
    await rollup(LATER, DROP);
    expect(await one("SELECT sum(rounds) AS n FROM cells2")).toEqual({ n: 3 });
    expect((await r2json<{ rounds: number }>("data/global/manifest.json"))!.rounds).toBe(3);
  });

  it("keeps the rounds of an id merged into a banned contributor out too, once that one unlinks", async () => {
    const a = await joinNew(), b = await joinNew(), c = await joinNew();
    await upload(a.key, series(2, { tag: "0a0000000001" }));
    await upload(b.key, series(4, { tag: "0b0000000001" }));
    await upload(c.key, series(3, { tag: "0c0000000001" }));
    await admin("ban", { id: b.id });
    await rollup();
    await rollup(LATER, DROP);
    // a turns out to be b's: merged into it after its day was archived, then b leaves.
    await admin("merge", { from: a.id, into: b.id }, LATER);
    await unlink(b.key, LATER);
    await rollup(LATER, DROP);
    const day = "2026-10-14";
    const files = await r2keys(archiveKey(day, ""));
    expect(named(files, a.id)).toEqual([]);
    expect(named(files, b.id)).toEqual([]);
    await admin("restore", { day }, LATER);
    await rollup(LATER, DROP);
    // Only c's rounds are public, before and after.
    expect(await one("SELECT sum(rounds) AS n FROM cells2")).toEqual({ n: 3 });
  });

  it("archives an unlinking contributor's rounds unnamed", async () => {
    const a = await joinNew();
    await upload(a.key, series(4));
    await rollup();
    // Unlinked just as its day becomes final, with the re-filing not yet done.
    await unlink(a.key, LATER);
    await rollup(LATER, { ...env, RUN_R2_BUDGET: "6" }, 1);
    const files = await r2keys(archiveKey("2026-10-14", ""));
    expect(named(files, a.id)).toEqual([]);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect((await r2json<{ contributor: number | null }>(f))!.contributor).toBeNull();
    const all = await Promise.all(files.map(f => r2json<{ n: number }>(f)));
    expect(all.reduce((n, f) => n + f!.n, 0)).toBe(4);
  });
});
