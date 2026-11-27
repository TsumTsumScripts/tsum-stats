// The skill level correction on the global side (CONTRACT §3.2 step 1c):
// the evidence the fold and the recompute keep (skill_units), the job step
// that judges it once a day with the page's own rules (ui/src/lib/skillFix.js),
// and the recompute that files a fixed run's rounds under the level they count at.
import { beforeEach, describe, expect, it } from "vitest";
import { dayOf } from "../src/days";
import { runJob } from "../src/job";
import { decide, unitRuns } from "../src/refile";
import { DAY_MS, NOW, TAG_B, admin, env, joinNew, one, r2json, rollup, rows, series, upload, wipe } from "./helpers";
import { checkAgainstReference, counted } from "./reference";

beforeEach(wipe);

const HOUR = 3600_000;
const day = (back: number, now = NOW) => dayOf((now - back * DAY_MS) / 1000);
/** n rounds of one device ending `back` days before NOW (at 18:00 UTC, so all on that day). */
const played = (back: number, n: number, spec: Parameters<typeof series>[1] = {}) => series(n, { end: NOW - back * DAY_MS, ...spec });
/** The job until nothing is left, twice over: the fold queues a Tsum for the pass of the run after. */
const job = async (now = NOW) => [...(await rollup(now)), ...(await rollup(now))];
const levels = (where = "") => rows<{ day: string; skill: number; stated: number; n: number }>(
  `SELECT day, skill, stated, sum(rounds) AS n FROM cells4 ${where} GROUP BY day, skill, stated ORDER BY day, skill, stated`);

/** Level 5 for a day, then 30 rounds recorded at 3 with the same coins, then 5 again. */
async function sandwich(key: string, spec: Parameters<typeof series>[1] = {}) {
  await upload(key, played(3, 40, { skill: 5, ...spec }));
  await upload(key, played(2, 30, { skill: 3, ...spec }));
  await upload(key, played(1, 40, { skill: 5, ...spec }));
}

describe("the evidence", () => {
  it("keeps a row per day, device, recorded level, item context and trusted, as the fold and the recompute make it", async () => {
    const c = await joinNew();
    await upload(c.key, [
      ...played(2, 3, { skill: 4, items: ["bonusCoin", "bonus5to4"], base: 100 }),
      // +Coin, +Exp and +Score are not part of the context; a round with no coins counts but adds no value.
      ...played(2, 2, { skill: 4, items: ["bonus5to4", "bonusExp", "bonusScore"], base: 50, end: NOW - 2 * DAY_MS - HOUR }),
      ...played(2, 1, { skill: 4, items: ["bonus5to4"], base: 0, end: NOW - 2 * DAY_MS - 2 * HOUR }),
      // Another context, a trusted version, no items known, no level (left out), and a medal Tsum (judged on medals).
      ...played(2, 2, { skill: 4, items: [], end: NOW - 2 * DAY_MS - 3 * HOUR }),
      ...played(2, 2, { skill: 4, items: ["bonus5to4"], version: "6.0b3", end: NOW - 2 * DAY_MS - 4 * HOUR }),
      ...played(2, 1, { skill: 4, items: null, end: NOW - 2 * DAY_MS - 5 * HOUR }),
      ...played(2, 4, { skill: "", end: NOW - 2 * DAY_MS - 6 * HOUR }),
      ...played(1, 3, { skill: 2, tsum: "mickeyplus", medals: 150, base: 900, tag: TAG_B }),
    ]);
    await rollup();
    const units = "SELECT day, tsum, skill, context, trusted, n, vn, vsum FROM skill_units ORDER BY tsum, context, trusted";
    const want = [
      { day: day(2), tsum: "mickey", skill: 4, context: -1, trusted: 0, n: 1, vn: 1, vsum: 3000 },
      { day: day(2), tsum: "mickey", skill: 4, context: 0, trusted: 0, n: 2, vn: 2, vsum: 6000 },
      { day: day(2), tsum: "mickey", skill: 4, context: 2, trusted: 0, n: 6, vn: 5, vsum: 400 },
      { day: day(2), tsum: "mickey", skill: 4, context: 2, trusted: 1, n: 2, vn: 2, vsum: 6000 },
      { day: day(1), tsum: "mickeyplus", skill: 2, context: 4, trusted: 0, n: 3, vn: 3, vsum: 450 },
    ];
    expect(await rows(units)).toEqual(want);
    expect(await one("SELECT count(DISTINCT device) AS n FROM skill_units")).toEqual({ n: 2 });
    await checkAgainstReference(new Set());
    // A full recompute makes the same rows from the rounds, and writes none of them again.
    await admin("rebuild", {});
    const k = counted();
    await runJob(k.env, NOW);
    const touched = k.n.writes.filter(w => /skill_units/.test(w.sql));
    expect(touched.length).toBeGreaterThanOrEqual(6);
    expect(touched.every(w => w.rows === 0)).toBe(true);
    expect(await rows(units)).toEqual(want);
    await checkAgainstReference(new Set());
  });

  it("makes a day's units again when an upload's sums are from before them, and leaves a banned contributor's out", async () => {
    const c = await joinNew(), b = await joinNew();
    await upload(c.key, played(1, 5, { skill: 4 }));
    await upload(b.key, played(1, 5, { skill: 6, tag: TAG_B }));
    // Sums an older Worker left (format 1: no units): the cells are added in, the day is recomputed for its units.
    await env.DB.prepare("UPDATE pending SET format = 1, units = '[]'").run();
    const [first] = await rollup();
    expect(first.folded).toBe(10);
    expect(await one("SELECT sum(rounds) AS n FROM cells4")).toEqual({ n: 10 });
    expect(await rows("SELECT skill, n FROM skill_units ORDER BY skill")).toEqual([{ skill: 4, n: 5 }, { skill: 6, n: 5 }]);
    await admin("ban", { id: b.id });
    await rollup();
    expect(await rows("SELECT skill, n FROM skill_units ORDER BY skill")).toEqual([{ skill: 4, n: 5 }]);
    await checkAgainstReference(new Set([b.id]));
  });
});

describe("the correction", () => {
  it("files a run recorded at a wrong level under the right one, a day at a time, and says so in the part", async () => {
    const c = await joinNew();
    await sandwich(c.key);
    const first = await rollup();
    // New rounds are filed as recorded; the Tsum waits for the next run's pass.
    expect(first.flatMap(r => r.refiled)).toEqual([]);
    expect(await levels()).toEqual([
      { day: day(3), skill: 5, stated: 5, n: 40 }, { day: day(2), skill: 3, stated: 3, n: 30 }, { day: day(1), skill: 5, stated: 5, n: 40 },
    ]);
    expect((await one<{ value: string }>("SELECT value FROM state WHERE key = 'refile_queue'")).value).toBe('{"mickey":1}');

    const [pass, ...after] = await rollup();
    expect(pass.refiled).toEqual(["mickey"]);
    expect(pass.recomputed).toEqual([]);
    expect(pass.more).toBe(true);
    expect(await rows("SELECT tsum, build, stated, from_day, to_day, level, rule, rounds, days, at FROM skill_fix")).toEqual([
      { tsum: "mickey", build: 0, stated: 3, from_day: day(2), to_day: day(2), level: 5, rule: "order", rounds: 30, days: JSON.stringify({ [day(2)]: 30 }), at: NOW / 1000 },
    ]);
    // Only the day the fix covers is recomputed, and published again.
    expect(after.flatMap(r => r.recomputed)).toEqual([day(2)]);
    expect(after.flatMap(r => r.rendered)).toEqual([expect.stringContaining(`day-${day(2)}.`)]);
    expect(await levels()).toEqual([
      { day: day(3), skill: 5, stated: 5, n: 40 }, { day: day(2), skill: 5, stated: 3, n: 30 }, { day: day(1), skill: 5, stated: 5, n: 40 },
    ]);
    expect(await rows("SELECT DISTINCT skill, stated FROM cell_bins4 WHERE day = ?1", day(2))).toEqual([{ skill: 5, stated: 3 }]);
    await checkAgainstReference(new Set(), new Set(), undefined, [day(2)]);
    // The evidence stays as recorded, and the round itself is never changed.
    expect(await rows("SELECT skill, sum(n) AS n FROM skill_units GROUP BY skill ORDER BY skill")).toEqual([{ skill: 3, n: 30 }, { skill: 5, n: 80 }]);
    expect(await one("SELECT count(*) AS n FROM rounds WHERE skill = 3")).toEqual({ n: 30 });

    const m = (await r2json<{ parts: { from: string; file: string }[]; skills: number[] }>("data/global/manifest.json"))!;
    const file = m.parts.find(p => p.from === day(2))!.file;
    const part = (await r2json<{ format: number; cells: Record<string, unknown[]>; bins: Record<string, unknown[]> }>("data/global/" + file))!;
    expect(part.format).toBe(7);
    expect([part.cells.skill, part.cells.stated, part.cells.rounds]).toEqual([[5], [3], [30]]);
    expect([part.bins.skill, part.bins.stated]).toEqual([[5], [3]]);
    expect(m.skills).toEqual([5]);

    // The recompute left the units as they were, so nothing is queued, and a later run that day does nothing.
    expect((await one<{ value: string }>("SELECT value FROM state WHERE key = 'refile_queue'")).value).toBe("{}");
    const again = await rollup(NOW + HOUR);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ refiled: [], recomputed: [], rendered: [], more: false, errors: [] });
  });

  it("corrects a Tsum once a day: new rounds wait for the next day's pass, which recomputes only what changed", async () => {
    const c = await joinNew();
    await sandwich(c.key);
    await job();
    // More rounds the same day, on the fixed day (sent late) and a new one: filed as recorded, and no second pass today.
    await upload(c.key, played(2, 10, { skill: 3, end: NOW - 2 * DAY_MS - 4 * HOUR }), NOW + HOUR);
    const today = await job(NOW + HOUR);
    expect(today.flatMap(r => r.refiled)).toEqual([]);
    expect(today.flatMap(r => r.recomputed)).toEqual([]);
    expect(await levels(`WHERE day = '${day(2)}'`)).toEqual([{ day: day(2), skill: 3, stated: 3, n: 10 }, { day: day(2), skill: 5, stated: 3, n: 30 }]);

    // The next day's first run takes the Tsum again: the late rounds' day is recomputed, the others are not.
    const next = await job(NOW + DAY_MS);
    expect(next.flatMap(r => r.refiled)).toEqual(["mickey"]);
    expect(next.flatMap(r => r.recomputed)).toEqual([day(2)]);
    expect(await levels(`WHERE day = '${day(2)}'`)).toEqual([{ day: day(2), skill: 5, stated: 3, n: 40 }]);
    expect(await one("SELECT rounds, days FROM skill_fix")).toEqual({ rounds: 40, days: JSON.stringify({ [day(2)]: 40 }) });
    // With nothing new, the day after has nothing to do.
    const idle = await job(NOW + 2 * DAY_MS);
    expect(idle.flatMap(r => r.refiled)).toEqual([]);
    expect(idle.flatMap(r => r.recomputed)).toEqual([]);
  });

  it("leaves today's rounds as recorded until today is over", async () => {
    const c = await joinNew();
    await upload(c.key, played(2, 40, { skill: 5 }));
    await upload(c.key, played(1, 40, { skill: 5, end: NOW - DAY_MS }));
    // The wrong level runs from yesterday evening into today.
    await upload(c.key, played(1, 25, { skill: 3, end: NOW - DAY_MS + 5 * HOUR }));
    await upload(c.key, played(0, 25, { skill: 3, end: NOW - 6 * HOUR }));
    await upload(c.key, played(0, 40, { skill: 5, end: NOW - HOUR }));
    const runs = await job();
    expect(runs.flatMap(r => r.recomputed)).toEqual([day(1)]);
    expect(await one("SELECT from_day, to_day, level, rounds, days FROM skill_fix")).toEqual(
      { from_day: day(1), to_day: day(0), level: 5, rounds: 50, days: JSON.stringify({ [day(1)]: 25 }) });
    expect(await levels("WHERE stated = 3")).toEqual([{ day: day(1), skill: 5, stated: 3, n: 25 }, { day: day(0), skill: 3, stated: 3, n: 25 }]);
    // Tomorrow, today is a past day like any other.
    await upload(c.key, played(-1, 1, { skill: 5, end: NOW + DAY_MS - HOUR }), NOW + DAY_MS);
    expect((await job(NOW + DAY_MS)).flatMap(r => r.recomputed)).toEqual([day(0)]);
    expect(await levels("WHERE stated = 3")).toEqual([{ day: day(1), skill: 5, stated: 3, n: 25 }, { day: day(0), skill: 5, stated: 3, n: 25 }]);
    await checkAgainstReference(new Set(), new Set(), undefined, [day(1), day(0)]);
  });

  it("leaves a real progression, another device's levels and a run with other coins alone", async () => {
    const c = await joinNew();
    // Levels going up with the coins.
    await upload(c.key, played(3, 40, { skill: 3, base: 3000 }));
    await upload(c.key, played(2, 40, { skill: 4, base: 3900 }));
    await upload(c.key, played(1, 40, { skill: 5, base: 4800 }));
    // Another device at a lower level in between, with the same coins: its own account.
    await upload(c.key, played(2, 30, { skill: 3, base: 4800, tag: TAG_B, end: NOW - 2 * DAY_MS - 5 * HOUR }));
    // Levels going down on one device, but at half the coins: not the same level's rounds.
    await upload(c.key, played(3, 40, { skill: 5, tsum: "donald", base: 8000 }));
    await upload(c.key, played(2, 30, { skill: 2, tsum: "donald", base: 4000 }));
    await upload(c.key, played(1, 40, { skill: 5, tsum: "donald", base: 8000 }));
    const runs = await job();
    expect(runs.flatMap(r => r.refiled).sort()).toEqual(["donald", "mickey"]);
    expect(runs.flatMap(r => r.recomputed)).toEqual([]);
    expect(await one("SELECT count(*) AS n FROM skill_fix")).toEqual({ n: 0 });
    expect(await one("SELECT count(*) AS n FROM cells4 WHERE skill != stated")).toEqual({ n: 0 });
  });

  it("takes a fix back when its evidence goes, and recomputes the days it had moved", async () => {
    const c = await joinNew();
    await sandwich(c.key);
    await job();
    expect(await one("SELECT count(*) AS n FROM cells4 WHERE skill != stated")).toEqual({ n: 1 });
    // The level 5 rounds turn out to be level 3's too (as rounds sent again, changed, would): nothing is out of order any more.
    await env.DB.batch([
      env.DB.prepare("UPDATE rounds SET skill = 3 WHERE skill = 5"),
      env.DB.prepare("INSERT OR IGNORE INTO dirty_days (day) VALUES (?1), (?2)").bind(day(3), day(1)),
    ]);
    await rollup();
    const next = await job(NOW + DAY_MS);
    expect(next.flatMap(r => r.refiled)).toEqual(["mickey"]);
    expect(next.flatMap(r => r.recomputed)).toEqual([day(2)]);
    expect(await one("SELECT count(*) AS n FROM skill_fix")).toEqual({ n: 0 });
    expect(await levels()).toEqual([
      { day: day(3), skill: 3, stated: 3, n: 40 }, { day: day(2), skill: 3, stated: 3, n: 30 }, { day: day(1), skill: 3, stated: 3, n: 40 },
    ]);
    await checkAgainstReference(new Set());
  });

  it("goes over a few Tsums a run, within the run's queries, and leaves the rest for the next", async () => {
    const c = await joinNew();
    for (const tsum of ["mickey", "minnie", "donald"]) await sandwich(c.key, { tsum, tag: TAG_B });
    await rollup();
    const k = counted();
    const pass = await runJob(k.env, NOW);
    expect(pass.refiled).toEqual(["donald", "mickey"]);
    expect(pass.more).toBe(true);
    expect(k.n.q).toBeLessThanOrEqual(45);
    // Two Tsums: a read of two statements each, and one batch of writes (their fixes, the days, the queue, the days corrected).
    const mine = [...k.n.bySql].filter(([sql]) => /skill_units WHERE tsum|skill_fix|refile_queue' *$|'refiled'|dirty_days \(day\) SELECT value FROM json_each/.test(sql));
    expect(mine.reduce((n, [, e]) => n + e.n, 0)).toBeLessThanOrEqual(2 * 2 + 2 * 2 + 3);
    const rest = await rollup();
    expect(rest.flatMap(r => r.refiled)).toEqual(["minnie"]);
    expect(await rows("SELECT tsum, level FROM skill_fix ORDER BY tsum")).toEqual([
      { tsum: "donald", level: 5 }, { tsum: "mickey", level: 5 }, { tsum: "minnie", level: 5 },
    ]);
    expect(await one("SELECT sum(rounds) AS n FROM cells4 WHERE skill = 5 AND stated = 3")).toEqual({ n: 90 });
    // The read budget puts the pass off, and it is taken up again when there is room.
    await upload(c.key, played(0, 1, { skill: 5, tag: TAG_B, end: NOW + DAY_MS - HOUR }), NOW + DAY_MS);
    await rollup(NOW + DAY_MS);
    const tight = { ...env, READ_BUDGET_PER_DAY: "50" };
    const off = await runJob(tight, NOW + DAY_MS);
    expect(off).toMatchObject({ refiled: [], more: true, errors: [] });
    expect((await rollup(NOW + DAY_MS)).flatMap(r => r.refiled)).toEqual(["mickey"]);
  });
});

describe("decide", () => {
  const run = (device: string, skill: number, days: [string, number][], coins: number, over: Partial<{ build: number; trusted: boolean; first: number }> = {}) => {
    const n = days.reduce((s, [, k]) => s + k, 0);
    return { build: over.build ?? 0, device, run: 0, skill, context: 2, n, tn: over.trusted ? n : 0, vn: n, vsum: n * coins,
      first: over.first ?? 0, last: (over.first ?? 0) + 1, days: JSON.stringify(days) };
  };
  it("puts a run's rows together and keeps a fix through a little drift", () => {
    const rows = [
      { ...run("d", 5, [["2026-10-01", 60]], 9000, { first: 1 }), run: 1 },
      { ...run("d", 3, [["2026-10-02", 20], ["2026-10-03", 20]], 7700, { first: 3 }), run: 2 },
      { ...run("d", 3, [["2026-10-03", 5]], 100, { first: 4 }), run: 2, context: 0 },
      { ...run("d", 5, [["2026-10-04", 60]], 9000, { first: 6 }), run: 3 },
    ];
    const runs = unitRuns(rows);
    expect(runs.map(r => [r.level, r.n, r.contexts.length, [...r.days]])).toEqual([
      [5, 60, 1, [["2026-10-01", 60]]], [3, 45, 2, [["2026-10-02", 20], ["2026-10-03", 25]]], [5, 60, 1, [["2026-10-04", 60]]],
    ]);
    // 14 % under its neighbours: not the same coins, so no fix is made...
    expect(decide(runs, [], "2026-10-10", 100)).toEqual({ fixes: [], dirty: [] });
    // ...but one already made is kept, its day it was made on with it, and nothing is recomputed for it.
    const had = { build: 0, device: "d", stated: 3, from_day: "2026-10-02", to_day: "2026-10-03", level: 5, rule: "order", rounds: 45,
      days: JSON.stringify({ "2026-10-02": 20, "2026-10-03": 25 }), at: 7 };
    expect(decide(runs, [had], "2026-10-10", 100)).toEqual({ fixes: [had], dirty: [] });
    // Far enough apart, it is taken back, and its days are recomputed.
    rows[1].vsum = 40 * 6000;
    expect(decide(unitRuns(rows), [had], "2026-10-10", 100)).toEqual({ fixes: [], dirty: ["2026-10-02", "2026-10-03"] });
  });
});
