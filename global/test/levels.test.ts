// A contributor's own level for a round (CONTRACT §1.3, §2.8): sent with an
// upload or alone, stored for good, applied by a day's recompute ahead of the
// site's own correction, on open, archived and dropped days alike.
import { beforeEach, describe, expect, it } from "vitest";
import { dayOf } from "../src/days";
import { ADMIN, DAY_MS, NOW, TAG_B, admin, call, env, joinNew, json, one, r2json, r2keys, rollup, rows, series, upload, wipe } from "./helpers";
import { checkAgainstReference } from "./reference";

beforeEach(wipe);

const day = (back: number) => dayOf((NOW - back * DAY_MS) / 1000);
const played = (back: number, n: number, spec: Parameters<typeof series>[1] = {}) => series(n, { end: NOW - back * DAY_MS, ...spec });
const withLevel = (recs: Record<string, string>[], level: number | "", source = "list") => recs.map(r => ({ ...r, skill_eff: String(level), skill_src: level === "" ? "" : source }));
const cells = (where = "") => rows<{ day: string; skill: number; stated: number; n: number }>(
  `SELECT day, skill, stated, sum(rounds) AS n FROM cells4 ${where} GROUP BY day, skill, stated ORDER BY day, skill, stated`);
const sendLevels = async (key: string, levels: unknown[], now = NOW) => {
  const res = await call("/api/v1/levels", { body: { schema: "gap.round-levels/1", levels }, key, now });
  return { status: res.status, body: await json<Record<string, unknown>>(res) };
};
const item = (r: Record<string, string>, level: number | "", source = "list") => ({ id: r.id, skill_eff: String(level), skill_src: level === "" ? "" : source });

describe("a level sent with a round", () => {
  it("is stored beside the round, never as a setting, and files the round at it", async () => {
    const c = await joinNew();
    const recs = played(1, 6, { skill: 6 });
    const up = await upload(c.key, [...withLevel(recs.slice(0, 4), 1), ...recs.slice(4)]);
    expect(up.body).toMatchObject({ accepted: 6, levels: 1 });
    expect(await rows("SELECT level, source, count(*) AS n FROM round_levels GROUP BY level, source")).toEqual([{ level: 1, source: "list", n: 4 }]);
    // The recorded level and the settings are as an upload without the fields leaves them.
    expect(await one("SELECT count(*) AS n, min(skill) AS lo, max(skill) AS hi, count(DISTINCT settings) AS s FROM rounds")).toEqual({ n: 6, lo: 6, hi: 6, s: 1 });
    expect(await one("SELECT count(*) AS n FROM settings WHERE json LIKE '%skill_eff%' OR json LIKE '%skill_src%'")).toEqual({ n: 0 });
    await rollup();
    expect(await cells()).toEqual([{ day: day(1), skill: 1, stated: 6, n: 4 }, { day: day(1), skill: 6, stated: 6, n: 2 }]);
    // The evidence counts a list's level as the round's, and as trusted.
    expect(await rows("SELECT skill, trusted, n FROM skill_units ORDER BY skill")).toEqual([{ skill: 1, trusted: 1, n: 4 }, { skill: 6, trusted: 0, n: 2 }]);
    await checkAgainstReference(new Set());

    // Sent again the same: nothing is written. Changed, or no longer sent: the round's day is made again.
    const same = await upload(c.key, [...withLevel(recs.slice(0, 4), 1), ...recs.slice(4)]);
    expect(same.body).toMatchObject({ accepted: 0, unchanged: 6 });
    const changed = await upload(c.key, [...withLevel(recs.slice(0, 2), 2, "pick"), ...recs.slice(2)]);
    expect(changed.body).toMatchObject({ accepted: 4, unchanged: 2 });
    await rollup();
    expect(await cells()).toEqual([{ day: day(1), skill: 2, stated: 6, n: 2 }, { day: day(1), skill: 6, stated: 6, n: 4 }]);
    expect(await rows("SELECT level, source, count(*) AS n FROM round_levels GROUP BY level, source")).toEqual([{ level: 2, source: "pick", n: 2 }]);
    await checkAgainstReference(new Set());
  });

  it("turns away a level it cannot read, and ignores one on another contributor's round", async () => {
    const c = await joinNew(), d = await joinNew();
    const recs = played(1, 4, { skill: 5 });
    const bad = await upload(c.key, [
      { ...recs[0], skill_eff: "11", skill_src: "list" }, { ...recs[1], skill_eff: "3", skill_src: "guess" },
      { ...recs[2], skill_eff: "3", skill_src: "" }, recs[3],
    ]);
    expect(bad.body).toMatchObject({ accepted: 1, rejected: { field: 3 } });
    await upload(c.key, recs);
    const dup = await upload(d.key, withLevel(recs, 1));
    expect(dup.body).toMatchObject({ accepted: 0, duplicates: 4 });
    expect(await one("SELECT count(*) AS n FROM round_levels")).toEqual({ n: 0 });
  });

  it("leaves an upload with no level, as the script's, as it was", async () => {
    const res = await call("/api/v1/rounds", { body: { schema: "gap.round-stats/1", records: played(1, 3, { skill: 4 }) } });
    expect(await json(res)).toMatchObject({ ok: true, accepted: 3 });
    await rollup();
    expect(await cells()).toEqual([{ day: day(1), skill: 4, stated: 4, n: 3 }]);
    expect(await one("SELECT (SELECT count(*) FROM round_levels) + (SELECT count(*) FROM level_log) AS n")).toEqual({ n: 0 });
  });
});

describe("POST /api/v1/levels", () => {
  it("sets, changes and takes back the level of rounds the contributor sent, and of no others", async () => {
    const c = await joinNew(), d = await joinNew();
    const mine = played(2, 5, { skill: 6 }), theirs = played(2, 2, { skill: 6, tag: TAG_B });
    await upload(c.key, mine);
    await upload(d.key, theirs);
    await rollup();
    const never = played(3, 1, { skill: 6 })[0];
    const res = await sendLevels(c.key, [
      item(mine[0], 1), item(mine[1], 1), item(mine[2], 2, "order"), item(theirs[0], 1), item(never, 1),
      { id: "nope", skill_eff: "1", skill_src: "list" }, { id: mine[3].id, skill_eff: "0", skill_src: "list" }, item(mine[4], ""),
    ]);
    expect(res).toEqual({ status: 200, body: { ok: true, accepted: 3, unchanged: 1, unknown: 1, foreign: 1, invalid: 2, levels: 1 } });
    await rollup();
    expect(await cells()).toEqual([
      { day: day(2), skill: 1, stated: 6, n: 2 }, { day: day(2), skill: 2, stated: 6, n: 1 }, { day: day(2), skill: 6, stated: 6, n: 4 },
    ]);
    await checkAgainstReference(new Set());
    // The same again writes nothing; a changed one and one taken back do.
    expect((await sendLevels(c.key, [item(mine[0], 1), item(mine[1], 1)])).body).toMatchObject({ accepted: 0, unchanged: 2 });
    expect((await sendLevels(c.key, [item(mine[0], 3, "pick"), item(mine[1], "")])).body).toMatchObject({ accepted: 2, unchanged: 0 });
    await rollup();
    expect(await cells()).toEqual([
      { day: day(2), skill: 2, stated: 6, n: 1 }, { day: day(2), skill: 3, stated: 6, n: 1 }, { day: day(2), skill: 6, stated: 6, n: 5 },
    ]);
    // Every change went to the archive, in order, and out of D1.
    expect(await one("SELECT count(*) AS n FROM level_log")).toEqual({ n: 0 });
    const files = await r2keys("archive/levels/");
    const log = (await Promise.all(files.map(f => r2json<{ kind: string; format: number; levels: { seq: number; key: string; level: number | null; source: string | null }[] }>(f)))).flatMap(f => f!.levels);
    expect(log.sort((a, b) => a.seq - b.seq).map(l => [l.level, l.source])).toEqual([[1, "list"], [1, "list"], [2, "order"], [3, "pick"], [null, null]]);
  });

  it("is refused without a key, with another schema, or with nothing to read", async () => {
    const c = await joinNew();
    expect((await call("/api/v1/levels", { body: { schema: "gap.round-levels/1", levels: [] }, key: c.key })).status).toBe(400);
    expect((await call("/api/v1/levels", { body: { schema: "gap.round-stats/1", levels: [{}] }, key: c.key })).status).toBe(400);
    expect((await call("/api/v1/levels", { body: { schema: "gap.round-levels/1", levels: [{}] } })).status).toBe(401);
  });
});

describe("the order of evidence", () => {
  /** Level 5 for a day, 30 rounds recorded at 3 with the same coins, then 5 again: the site's own correction counts them at 5. */
  async function sandwich(key: string) {
    const mid = played(2, 30, { skill: 3 });
    await upload(key, played(3, 40, { skill: 5 }));
    await upload(key, mid);
    await upload(key, played(1, 40, { skill: 5 }));
    return mid;
  }
  const job = async (now = NOW) => [...(await rollup(now)), ...(await rollup(now))];

  it("puts a contributor's level, a list's or its app's coin rules', before the site's own verdict", async () => {
    const c = await joinNew();
    const mid = await sandwich(c.key);
    await job(NOW + DAY_MS);
    expect(await cells(`WHERE day = '${day(2)}'`)).toEqual([{ day: day(2), skill: 5, stated: 3, n: 30 }]);
    // Ten of them are level 4 by the contributor's Tsum List, five level 6 by its app's coin rules: both stand over the site's 5.
    expect((await sendLevels(c.key, [...mid.slice(0, 10).map(r => item(r, 4)), ...mid.slice(10, 15).map(r => item(r, 6, "trusted"))], NOW + DAY_MS)).body)
      .toMatchObject({ accepted: 15 });
    await job(NOW + 2 * DAY_MS);
    const got = await cells(`WHERE day = '${day(2)}'`);
    expect(got.find(r => r.skill === 4)).toEqual({ day: day(2), skill: 4, stated: 3, n: 10 });
    expect(got.find(r => r.skill === 6)).toEqual({ day: day(2), skill: 6, stated: 3, n: 5 });
    expect(got.reduce((n, r) => n + r.n, 0)).toBe(30);
    // The rest are still the site's to judge: at 5 or as recorded, never at a contributor's level.
    expect(got.filter(r => r.skill !== 4 && r.skill !== 6).every(r => r.skill === 5 || r.skill === 3)).toBe(true);
  });
});

describe("a level for a round of a day that is final", () => {
  /** Two months on: the days are archived. */
  const LATER = NOW + 62 * DAY_MS;
  const DROP = { ...env, RETAIN_ROWS: "0" };

  it("is applied to an archived day still in D1 by an ordinary recompute, though a round sent again is too old", async () => {
    const c = await joinNew();
    const recs = played(1, 6, { skill: 6 });
    await upload(c.key, recs);
    await rollup();
    await rollup(LATER);
    expect(await one("SELECT value FROM state WHERE key = 'archived_through'")).toMatchObject({ value: day(0) });
    // The round itself is refused as old; its level alone is taken.
    expect((await upload(c.key, withLevel(recs, 1), LATER)).body).toMatchObject({ accepted: 0, rejected: { old: 6 } });
    expect((await sendLevels(c.key, recs.slice(0, 4).map(r => item(r, 1)), LATER)).body).toMatchObject({ accepted: 4, unknown: 0 });
    const reports = await rollup(LATER);
    expect(reports.flatMap(r => r.recomputed)).toEqual([day(1)]);
    expect(await cells()).toEqual([{ day: day(1), skill: 1, stated: 6, n: 4 }, { day: day(1), skill: 6, stated: 6, n: 2 }]);
    // The published month has it.
    const man = await json<{ parts: { file: string }[] }>(call("/data/global/manifest.json", { now: LATER }));
    const part = await json<{ cells: { skill: number[]; stated: number[]; rounds: number[] } }>(call("/data/global/" + man.parts[0].file, { now: LATER }));
    expect(part.cells.skill.map((s, i) => [s, part.cells.stated[i], part.cells.rounds[i]]).sort()).toEqual([[1, 6, 4], [6, 6, 2]]);
  });

  it("waits for a restore when the day has left D1, and is there once the day is back", async () => {
    const c = await joinNew(), d = await joinNew();
    const recs = played(1, 6, { skill: 6 });
    await upload(c.key, recs);
    await rollup();
    await rollup(LATER, DROP);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    // Only a contributor that sent rounds of the device may level a round the site can no longer look up.
    expect((await sendLevels(d.key, recs.slice(0, 4).map(r => item(r, 1)), LATER)).body).toMatchObject({ accepted: 0, unknown: 4 });
    expect((await sendLevels(c.key, recs.slice(0, 4).map(r => item(r, 1)), LATER)).body).toMatchObject({ accepted: 4, unknown: 0 });
    expect(await one("SELECT value FROM state WHERE key = 'level_days'")).toEqual({ value: JSON.stringify([day(1)]) });
    // Nothing moves until the day is restored: the job cannot recompute rounds it does not have.
    await rollup(LATER, DROP);
    expect(await cells()).toEqual([{ day: day(1), skill: 6, stated: 6, n: 6 }]);
    const res = await json(call("/api/v1/admin/restore", { body: { levels: true }, key: ADMIN, now: LATER }));
    expect(res).toMatchObject({ ok: true, day: day(1), done: true, rounds: 6, days: 0 });
    const reports = await rollup(LATER, DROP);
    expect(reports.flatMap(r => r.recomputed)).toEqual([day(1)]);
    expect(reports.flatMap(r => r.dropped)).toEqual([day(1)]);
    expect(await cells()).toEqual([{ day: day(1), skill: 1, stated: 6, n: 4 }, { day: day(1), skill: 6, stated: 6, n: 2 }]);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    // The levels stay in D1 for good, so a later restore of the day files it the same way.
    expect(await one("SELECT count(*) AS n FROM round_levels")).toEqual({ n: 4 });
    expect(await json(admin("restore", { levels: true }, LATER))).toMatchObject({ day: null, done: true, days: 0 });
  });
});
