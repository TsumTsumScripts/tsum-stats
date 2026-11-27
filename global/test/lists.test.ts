// Tsum Lists as evidence (CONTRACT §1.3, §2.8, §3.2 step 1b'): a contributor's
// lists and links stored whole and archived, grouped into accounts by the
// page's own rules, and their bounds applied by a day's recompute ahead of
// the coin rules, on open, archived and dropped days alike.
import { beforeEach, describe, expect, it } from "vitest";
import { dayOf } from "../src/days";
import { boundsOf } from "../src/lists";
import { ADMIN, DAY_MS, NOW, TAG_A, TAG_B, admin, call, env, joinNew, json, one, r2json, r2keys, rollup, rows, series, upload, wipe } from "./helpers";
import { checkAgainstReference, counted } from "./reference";
import { sqlTime } from "../../ui/src/lib/snapshot/engine.js";

beforeEach(wipe);

const day = (back: number) => dayOf((NOW - back * DAY_MS) / 1000);
const played = (back: number, n: number, spec: Parameters<typeof series>[1] = {}) => series(n, { end: NOW - back * DAY_MS, ...spec });
const cells = (where = "") => rows<{ day: string; skill: number; stated: number; n: number }>(
  `SELECT day, skill, stated, sum(rounds) AS n FROM cells4 ${where} GROUP BY day, skill, stated ORDER BY day, skill, stated`);
/** A list as the forwarder sends it: `skills` of its Tsums, read at `at` (ms). */
const list = (id: string, at: number, skills: Record<string, number>, build = "global") => ({
  id: id.padEnd(16, "0"), stamp: sqlTime(Math.floor(at / 1000)), build,
  tsums: Object.entries(skills).map(([tsum, skill], i) => ({
    order: String(i + 1), tsum, name: tsum.toUpperCase(), level: String(skill * 5), level_cap: "50", skill: String(skill), skill_max: "6",
    skill_progress: "40", acquired: "2025-01-0" + (1 + (i % 9)), favorite: i % 2 ? "1" : "0",
  })),
});
const send = async (key: string, body: { lists?: unknown[]; links?: unknown[] }, now = NOW) => {
  const res = await call("/api/v1/lists", { body: { schema: "gap.tsum-lists/1", ...body }, key, now });
  return { status: res.status, body: await json<Record<string, any>>(res) };
};
const OTHERS = { abu: 3, stitch: 4, elsa: 2, olaf: 5, pooh: 1 };
/** The job until nothing is left, twice: the evidence step marks days for the run after. */
const job = async (now = NOW, e = env) => [...(await rollup(now, e)), ...(await rollup(now, e))];

describe("POST /api/v1/lists", () => {
  it("stores a list whole, once, and in the archive", async () => {
    const c = await joinNew();
    const l = list("a1", NOW - 2 * DAY_MS, { mickey: 1, ...OTHERS });
    const first = await send(c.key, { lists: [l] });
    expect(first).toEqual({ status: 200, body: { ok: true, accepted: 1, unchanged: 0, invalid: 0, links: { accepted: 0, unchanged: 0, invalid: 0 }, lists: 1 } });
    const row = await one<{ n: number; build: number; stamp: number; tsums: string; archived: number }>("SELECT n, build, stamp, tsums, archived FROM tsum_lists");
    expect(row).toMatchObject({ n: 6, build: 0, stamp: Math.floor((NOW - 2 * DAY_MS) / 1000), archived: 0 });
    // Every column of every Tsum, as sent.
    expect(JSON.parse(row.tsums)).toEqual(l.tsums);
    // The same list again writes nothing.
    const k = counted();
    const again = await call("/api/v1/lists", { body: { schema: "gap.tsum-lists/1", lists: [l] }, key: c.key, env: k.env });
    expect(await json(again)).toMatchObject({ accepted: 0, unchanged: 1 });
    expect(k.n.writes.reduce((n, w) => n + w.rows, 0)).toBe(0);
    await rollup();
    expect(await one("SELECT archived FROM tsum_lists")).toEqual({ archived: 1 });
    const files = await r2keys(`archive/lists/c${c.id}/`);
    expect(files).toHaveLength(1);
    expect(await r2json(files[0])).toMatchObject({ kind: "tsum-global-list", format: 1, contributor: c.id, id: l.id, build: 0, n: 6, tsums: l.tsums });
    // A list of any age is evidence: one read two years ago is taken.
    expect((await send(c.key, { lists: [list("a2", NOW - 700 * DAY_MS, { mickey: 1, ...OTHERS })] })).body).toMatchObject({ accepted: 1 });
    // The same id with other contents replaces it, and is archived again.
    expect((await send(c.key, { lists: [list("a1", NOW - 2 * DAY_MS, { mickey: 2, ...OTHERS })] })).body).toMatchObject({ accepted: 1, unchanged: 0 });
    await rollup();
    expect(await r2keys(`archive/lists/c${c.id}/`)).toHaveLength(3);
  });

  it("turns away what it cannot keep whole, and a request it cannot read", async () => {
    const c = await joinNew();
    const good = list("b1", NOW, { mickey: 1 });
    const res = await send(c.key, {
      lists: [good, { ...good, id: "nope" }, { ...good, id: "b2".padEnd(16, "0"), stamp: "yesterday" }, { ...good, id: "b3".padEnd(16, "0"), build: "mars" },
        { ...good, id: "b4".padEnd(16, "0"), tsums: [{ tsum: "no pe", skill: "1" }] }, { ...good, id: "b5".padEnd(16, "0"), tsums: [{ tsum: "mickey", name: "x".repeat(200) }] }],
      links: [{ build: "global", tag: TAG_A, list: good.id }, { build: "global", tag: "zz", list: good.id }, { build: "global", tag: TAG_B, list: "what" }, { build: "x", tag: TAG_B, list: "" }],
    });
    expect(res.body).toMatchObject({ accepted: 1, invalid: 5, links: { accepted: 1, unchanged: 0, invalid: 3 } });
    expect((await call("/api/v1/lists", { body: { schema: "gap.tsum-lists/1" }, key: c.key })).status).toBe(400);
    expect((await call("/api/v1/lists", { body: { schema: "gap.round-stats/1", lists: [good] }, key: c.key })).status).toBe(400);
    expect((await call("/api/v1/lists", { body: { schema: "gap.tsum-lists/1", lists: [good] } })).status).toBe(401);
  });

  it("is taken at the uploads' URL too, with a key or with none (a join first), for the Tsum script", async () => {
    const c = await joinNew();
    const body = { schema: "gap.tsum-lists/1", lists: [list("b7", NOW, { mickey: 1, ...OTHERS })], links: [{ build: "global", tag: TAG_A, list: "b7".padEnd(16, "0") }] };
    expect(await json(call("/api/v1/rounds", { body, key: c.key }))).toMatchObject({ ok: true, accepted: 1, links: { accepted: 1 }, lists: 1 });
    const keyless = await json<{ ok: boolean; id: number; key: string; accepted: number }>(call("/api/v1/rounds", { body, ip: "198.51.100.200" }));
    expect(keyless).toMatchObject({ ok: true, accepted: 1 });
    expect(keyless.id).toBeGreaterThan(c.id);
    expect(keyless.key).toHaveLength(43);
    expect(await rows("SELECT contributor FROM tsum_lists ORDER BY contributor")).toEqual([{ contributor: c.id }, { contributor: keyless.id }]);
    // A body that cannot be read makes no contributor.
    const before = await one<{ n: number }>("SELECT count(*) AS n FROM contributors");
    expect((await call("/api/v1/rounds", { body: { schema: "gap.tsum-lists/1" }, ip: "198.51.100.201" })).status).toBe(400);
    expect(await one("SELECT count(*) AS n FROM contributors")).toEqual(before);
  });

  it("is refused past the day's budget, and writes a row a list", async () => {
    const c = await joinNew();
    const k = counted();
    const res = await call("/api/v1/lists", { body: { schema: "gap.tsum-lists/1", lists: [list("c1", NOW, { mickey: 1, ...OTHERS }), list("c2", NOW - DAY_MS, { mickey: 1, ...OTHERS })] }, key: c.key, env: k.env });
    expect(res.status).toBe(200);
    // Two lists, the queue, the budget's own row.
    expect(k.n.writes.reduce((n, w) => n + w.rows, 0)).toBeLessThanOrEqual(5);
    await env.DB.prepare("INSERT OR REPLACE INTO budget (day, rows, reads) VALUES (?1, 65000, 0)").bind(dayOf(NOW / 1000)).run();
    const refused = await send(c.key, { lists: [list("c3", NOW, { mickey: 1 })] });
    expect(refused.status).toBe(503);
    expect(await one("SELECT count(*) AS n FROM tsum_lists")).toEqual({ n: 2 });
  });
});

describe("accounts and links", () => {
  const L = (id: string, build: number, stamp: number, skills: Record<string, number>) => ({ id, build, stamp, readings: Object.fromEntries(Object.entries(skills).map(([t, s]) => [t, [s, 0] as [number, number]])) });
  const main = { mickey: 5, abu: 6, stitch: 6, elsa: 3, olaf: 4, pooh: 2 }, fresh = { mickey: 1, abu: 1, stitch: 1, elsa: 1, olaf: 1, pooh: 1 };
  const played = new Set(["mickey", "abu"]);

  it("links a device to its game's account when the lists are one account's, and to none when they are two", () => {
    const one = [L("a", 0, 100, main), L("b", 0, 200, { ...main, mickey: 6 })];
    expect(boundsOf(one, [], ["d1", "d2"], played)).toEqual([
      ["mickey", 0, "d1", 0, 0, 5], ["mickey", 0, "d1", 100, 5, 6], ["mickey", 0, "d1", 200, 6, 0],
      ["abu", 0, "d1", 0, 0, 6], ["abu", 0, "d1", 100, 6, 6], ["abu", 0, "d1", 200, 6, 0],
      ["mickey", 0, "d2", 0, 0, 5], ["mickey", 0, "d2", 100, 5, 6], ["mickey", 0, "d2", 200, 6, 0],
      ["abu", 0, "d2", 0, 0, 6], ["abu", 0, "d2", 100, 6, 6], ["abu", 0, "d2", 200, 6, 0],
    ]);
    // The same emulator later holds a new account: two accounts, so nothing is linked by itself...
    const two = [...one, L("c", 0, 300, fresh)];
    expect(boundsOf(two, [], ["d1", "d2"], played)).toEqual([]);
    // ...a link names the account by one of its lists, "" says not known, and a link taken back (null) is no link.
    const got = boundsOf(two, [{ build: 0, device: "d2", list: "c" }, { build: 0, device: "d1", list: "" }, { build: 0, device: "d3", list: null }], ["d1", "d2", "d3"], played);
    expect(got).toEqual([["mickey", 0, "d2", 0, 0, 1], ["mickey", 0, "d2", 300, 1, 0], ["abu", 0, "d2", 0, 0, 1], ["abu", 0, "d2", 300, 1, 0]]);
    // The other game's rounds are another account's; "not known" also holds off the one-account rule.
    expect(boundsOf([L("j", 1, 100, fresh)], [{ build: 1, device: "d1", list: "" }], ["d1", "d2"], played).map(r => r[2])).toEqual(["d2", "d2", "d2", "d2"]);
    // A link to a list that is not there falls back to the rule.
    expect(boundsOf(one, [{ build: 0, device: "d1", list: "zz" }], ["d1"], played)).toHaveLength(6);
  });
});

describe("a list's bounds on the rounds", () => {
  it("files rounds recorded past what the lists read at the nearest level they allow, by the round's own time", async () => {
    const c = await joinNew();
    // Recorded at 6 two days ago and yesterday, at 2 today; the list read mickey at 3 yesterday at 12:00,
    // between yesterday's rounds: at most 3 before it, at least 3 after.
    const noon = NOW - DAY_MS - 6 * 3600_000;
    await upload(c.key, [
      ...played(2, 5, { skill: 6 }),
      ...series(4, { skill: 6, end: noon - 3600_000 }), ...series(3, { skill: 6, end: noon + 3 * 3600_000 }),
      ...played(0, 6, { skill: 2, end: NOW - 3600_000 }),
    ]);
    await job();
    expect(await cells()).toEqual([{ day: day(2), skill: 6, stated: 6, n: 5 }, { day: day(1), skill: 6, stated: 6, n: 7 }, { day: day(0), skill: 2, stated: 2, n: 6 }]);
    expect((await send(c.key, { lists: [list("d1", noon, { mickey: 3, ...OTHERS })] })).body).toMatchObject({ accepted: 1 });
    const reports = await job();
    expect(reports.flatMap(r => r.evidence)).toEqual([c.id]);
    expect(new Set(reports.flatMap(r => r.recomputed))).toEqual(new Set([day(2), day(1), day(0)]));
    expect(await rows("SELECT tsum, from_at, floor, cap FROM skill_bound ORDER BY from_at")).toEqual([
      { tsum: "mickey", from_at: 0, floor: 0, cap: 3 }, { tsum: "mickey", from_at: Math.floor(noon / 1000), floor: 3, cap: 0 },
    ]);
    expect(await cells()).toEqual([
      { day: day(2), skill: 3, stated: 6, n: 5 },
      { day: day(1), skill: 3, stated: 6, n: 4 }, { day: day(1), skill: 6, stated: 6, n: 3 },
      { day: day(0), skill: 3, stated: 2, n: 6 },
    ]);
    await checkAgainstReference(new Set());
    // A second list after everything reads 3 as well: the rounds between the two are pinned at 3, and count as trusted evidence.
    await send(c.key, { lists: [list("d2", NOW, { mickey: 3, ...OTHERS })] });
    await job();
    expect(await cells(`WHERE day = '${day(1)}'`)).toEqual([{ day: day(1), skill: 3, stated: 6, n: 7 }]);
    expect(await rows(`SELECT skill, trusted, sum(n) AS n FROM skill_units GROUP BY skill, trusted`)).toEqual([{ skill: 3, trusted: 0, n: 9 }, { skill: 3, trusted: 1, n: 9 }]);
    await checkAgainstReference(new Set());
    // New rounds the lists bound are filed by them too: the upload's day is made again.
    await upload(c.key, series(2, { skill: 1, end: NOW + 3600_000 }), NOW + 2 * 3600_000);
    await rollup(NOW + 2 * 3600_000);
    expect(await cells(`WHERE day = '${day(0)}'`)).toEqual([{ day: day(0), skill: 3, stated: 1, n: 2 }, { day: day(0), skill: 3, stated: 2, n: 6 }]);
  });

  it("follows a link and its withdrawal, and never another contributor's lists", async () => {
    const c = await joinNew(), d = await joinNew();
    await upload(c.key, played(1, 5, { skill: 6 }));
    await upload(d.key, played(1, 4, { skill: 6, tag: TAG_B }));
    // Two accounts on c's lists, so nothing is linked until c says which one device A plays.
    const main = list("e1", NOW, { mickey: 2, ...OTHERS }), other = list("e2", NOW - 3600_000, { mickey: 6, abu: 6, stitch: 6, elsa: 6, olaf: 6, pooh: 6 });
    await send(c.key, { lists: [main, other] });
    await job();
    expect(await cells()).toEqual([{ day: day(1), skill: 6, stated: 6, n: 9 }]);
    expect((await send(c.key, { links: [{ build: "global", tag: TAG_A, list: main.id }] })).body.links).toEqual({ accepted: 1, unchanged: 0, invalid: 0 });
    await job();
    // d's rounds of the same Tsum, and of the same day, stay as recorded.
    expect(await cells()).toEqual([{ day: day(1), skill: 2, stated: 6, n: 5 }, { day: day(1), skill: 6, stated: 6, n: 4 }]);
    await checkAgainstReference(new Set());
    expect((await send(c.key, { links: [{ build: "global", tag: TAG_A, list: main.id }] })).body.links).toMatchObject({ accepted: 0, unchanged: 1 });
    // "Not known", then the answer taken back: both leave the rounds as recorded again.
    await send(c.key, { links: [{ build: "global", tag: TAG_A, list: "" }] });
    await job();
    expect(await cells()).toEqual([{ day: day(1), skill: 6, stated: 6, n: 9 }]);
    await send(c.key, { links: [{ build: "global", tag: TAG_A, list: main.id }] });
    await job();
    await send(c.key, { links: [{ build: "global", tag: TAG_A, list: null }] });
    await job();
    expect(await cells()).toEqual([{ day: day(1), skill: 6, stated: 6, n: 9 }]);
    expect(await one("SELECT count(*) AS n FROM skill_bound")).toEqual({ n: 0 });
    // The links are in the archive each time they changed.
    expect((await r2keys(`archive/lists/c${c.id}/`)).filter(f => f.includes("links.")).length).toBeGreaterThanOrEqual(1);
    const links = await r2json<{ kind: string; links: { list: string | null }[] }>((await r2keys(`archive/lists/c${c.id}/`)).filter(f => f.includes("links.")).at(-1)!);
    expect(links).toMatchObject({ kind: "tsum-global-links", links: [{ build: 0, list: null }] });
  });

  it("puts the lists before the coin rules, which still judge inside them", async () => {
    const c = await joinNew();
    // Level 5 for a day, 30 rounds recorded at 3 with the same coins, then 5 again: the coin rules count them at 5.
    await upload(c.key, played(3, 40, { skill: 5 }));
    await upload(c.key, played(2, 30, { skill: 3 }));
    await upload(c.key, played(1, 40, { skill: 5 }));
    await job(NOW + DAY_MS);
    expect(await cells(`WHERE day = '${day(2)}'`)).toEqual([{ day: day(2), skill: 5, stated: 3, n: 30 }]);
    // A list read after them all says 4: nothing was above 4, so the 5s count at 4 and the coin verdict of 5 is dropped.
    await send(c.key, { lists: [list("f1", NOW, { mickey: 4, ...OTHERS })] }, NOW + DAY_MS);
    await job(NOW + DAY_MS);
    await job(NOW + 2 * DAY_MS);
    const got = await cells();
    expect(got.every(r => r.skill <= 4)).toBe(true);
    expect(got.filter(r => r.stated === 5)).toEqual([{ day: day(3), skill: 4, stated: 5, n: 40 }, { day: day(1), skill: 4, stated: 5, n: 40 }]);
    // The 30 at "3" sit between runs at 4 with the same coins now: the coin rules move them to 4, inside the bound.
    expect(got.find(r => r.stated === 3)).toEqual({ day: day(2), skill: 4, stated: 3, n: 30 });
  });
});

describe("evidence for days that are final", () => {
  const LATER = NOW + 62 * DAY_MS;
  const DROP = { ...env, RETAIN_ROWS: "0" };

  it("moves the rounds of an archived day still in D1 by an ordinary recompute", async () => {
    const c = await joinNew();
    await upload(c.key, played(1, 6, { skill: 6 }));
    await rollup();
    await rollup(LATER);
    expect(await one("SELECT value FROM state WHERE key = 'archived_through'")).toMatchObject({ value: day(0) });
    await send(c.key, { lists: [list("91", LATER, { mickey: 1, ...OTHERS })] }, LATER);
    const reports = await job(LATER);
    expect(reports.flatMap(r => r.recomputed)).toEqual([day(1)]);
    expect(await cells()).toEqual([{ day: day(1), skill: 1, stated: 6, n: 6 }]);
    const man = await json<{ parts: { file: string }[] }>(call("/data/global/manifest.json", { now: LATER }));
    const part = await json<{ cells: { skill: number[]; stated: number[]; rounds: number[] } }>(call("/data/global/" + man.parts[0].file, { now: LATER }));
    expect(part.cells.skill.map((s, i) => [s, part.cells.stated[i], part.cells.rounds[i]])).toEqual([[1, 6, 6]]);
  });

  it("waits for a restore when the day has left D1", async () => {
    const c = await joinNew();
    await upload(c.key, played(1, 6, { skill: 6 }));
    await rollup();
    await rollup(LATER, DROP);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    await send(c.key, { lists: [list("92", LATER, { mickey: 1, ...OTHERS })] }, LATER);
    await job(LATER, DROP);
    expect(await one("SELECT value FROM state WHERE key = 'evidence_days'")).toEqual({ value: JSON.stringify([day(1)]) });
    expect(await cells()).toEqual([{ day: day(1), skill: 6, stated: 6, n: 6 }]);
    const res = await json(call("/api/v1/admin/restore", { body: { evidence: true }, key: ADMIN, now: LATER }));
    expect(res).toMatchObject({ ok: true, day: day(1), done: true, rounds: 6, days: 0 });
    const reports = await rollup(LATER, DROP);
    expect(reports.flatMap(r => r.recomputed)).toEqual([day(1)]);
    expect(reports.flatMap(r => r.dropped)).toEqual([day(1)]);
    expect(await cells()).toEqual([{ day: day(1), skill: 1, stated: 6, n: 6 }]);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    expect(await json(admin("restore", { evidence: true }, LATER))).toMatchObject({ day: null, done: true, days: 0 });
  });
});

describe("a contributor that leaves", () => {
  const setup = async () => {
    const c = await joinNew();
    await upload(c.key, played(1, 6, { skill: 6 }));
    await send(c.key, { lists: [list("93", NOW, { mickey: 1, ...OTHERS })], links: [{ build: "global", tag: TAG_A, list: "93".padEnd(16, "0") }] });
    await job();
    expect(await cells()).toEqual([{ day: day(1), skill: 1, stated: 6, n: 6 }]);
    expect((await r2keys(`archive/lists/c${c.id}/`)).length).toBe(2);
    return c;
  };

  it("leaves its lists, links and bounds behind as no one's, still bounding its rounds, and no file names it", async () => {
    const c = await setup(), d = await joinNew();
    // Another contributor with a list of the very same id, who leaves too: the two are never one group.
    await send(d.key, { lists: [list("93", NOW, { mickey: 4, ...OTHERS })] });
    await job();
    expect((await call("/api/v1/me/unlink", { body: {}, key: c.key })).status).toBe(200);
    expect((await call("/api/v1/me/unlink", { body: {}, key: d.key })).status).toBe(200);
    await job();
    expect(await one("SELECT count(*) AS n FROM contributors WHERE id != 0")).toEqual({ n: 0 });
    // Kept whole in D1, under contributor 0 and a word of each one's own.
    const lists = await rows<{ contributor: number; grp: string; n: number }>("SELECT contributor, grp, n FROM tsum_lists ORDER BY grp");
    expect(lists.map(l => [l.contributor, l.n])).toEqual([[0, 6], [0, 6]]);
    expect(new Set(lists.map(l => l.grp)).size).toBe(2);
    expect(lists.every(l => /^u[0-9a-f]{16}$/.test(l.grp))).toBe(true);
    const links = await rows<{ contributor: number; grp: string; list: string }>("SELECT contributor, grp, list FROM device_links");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ contributor: 0, list: "93".padEnd(16, "0") });
    expect(lists.map(l => l.grp)).toContain(links[0].grp);
    expect(await rows("SELECT DISTINCT contributor FROM skill_bound")).toEqual([{ contributor: 0 }]);
    // The archive's files are renamed, none deleted, and none names a contributor.
    expect(await r2keys(`archive/lists/c${c.id}/`)).toEqual([]);
    expect(await r2keys(`archive/lists/c${d.id}/`)).toEqual([]);
    const files = await r2keys("archive/lists/");
    expect(files).toHaveLength(3);
    expect(files.every(f => /^archive\/lists\/u[0-9a-f]{16}\//.test(f))).toBe(true);
    for (const f of files) expect(await r2json(f)).toMatchObject({ contributor: null });
    expect(await r2json(files.find(f => !f.includes("links."))!)).toMatchObject({ kind: "tsum-global-list", n: 6 });
    // Its rounds are no one's now and count as they did: the bounds still apply, through a full recompute too.
    expect(await cells()).toEqual([{ day: day(1), skill: 1, stated: 6, n: 6 }]);
    await admin("rebuild", {});
    await job();
    expect(await cells()).toEqual([{ day: day(1), skill: 1, stated: 6, n: 6 }]);
    await checkAgainstReference(new Set());
  });

  it("keeps a banned contributor's files as b files, and drops its rows with its rounds", async () => {
    const c = await setup();
    expect((await admin("ban", { id: c.id })).status).toBe(200);
    await job();
    expect(await cells()).toEqual([]);
    expect((await call("/api/v1/me/unlink", { body: {}, key: c.key })).status).toBe(200);
    await job();
    expect(await one("SELECT (SELECT count(*) FROM tsum_lists) + (SELECT count(*) FROM device_links) + (SELECT count(*) FROM skill_bound) + (SELECT count(*) FROM rounds) AS n")).toEqual({ n: 0 });
    const files = await r2keys("archive/lists/");
    expect(files).toHaveLength(2);
    expect(files.every(f => /^archive\/lists\/b[0-9a-f]{16}\//.test(f))).toBe(true);
    for (const f of files) expect(await r2json(f)).toMatchObject({ contributor: null });
  });
});
