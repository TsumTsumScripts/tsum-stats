// Archive and drop, restore, and month compaction (CONTRACT §3.2 steps 4-5, §3.4).
import { beforeEach, describe, expect, it } from "vitest";
import { archiveKey } from "../src/archive";
import { dayRange, dayStart, keyDay } from "../src/days";
import type { Env } from "../src/env";
import { runJob } from "../src/job";
import { ADMIN, DAY_MS, NOW, admin, call, env, json, one, r2json, r2keys, record, rollup, rows, upload, wipe, joinNew } from "./helpers";
import { D1_VALUE_MAX, checkAgainstReference, counted, dataset, tables, type RoundRow } from "./reference";

beforeEach(wipe);

/** Two months on: every day of the dataset is final. */
const LATER = NOW + 62 * DAY_MS;
const DAYS = ["2026-10-12", "2026-10-13", "2026-10-14"];
/** Drops archived days at once (RETAIN_ROWS 0), as a deployment past its RETAIN_ROWS does. */
const DROP = { ...env, RETAIN_ROWS: "0" };

interface ArchiveFile {
  kind: string; format: number; day: string; contributor: number | null; n: number;
  key: string[]; playedAt: number[]; build: number[]; tsum: string[]; skill: number[]; skillType: string[]; items: number[]; version: string[];
  settings: number[]; duration: number[]; score: number[]; base: number[]; final: number[]; medals: (number | null)[];
}

/** An archive file back into rounds rows, checking its arrays line up. */
function fileRows(f: ArchiveFile): Record<string, unknown>[] {
  const cols: [string, keyof ArchiveFile][] = [["key", "key"], ["played_at", "playedAt"], ["build", "build"], ["tsum", "tsum"],
    ["skill", "skill"], ["skill_type", "skillType"], ["items", "items"], ["version", "version"], ["settings", "settings"], ["duration", "duration"],
    ["score", "score"], ["base", "base"], ["final", "final"], ["medals", "medals"]];
  for (const [, c] of cols) expect(f[c], c).toHaveLength(f.n);
  return Array.from({ length: f.n }, (_, i) => Object.fromEntries(cols.map(([name, c]) => [name, (f[c] as unknown[])[i]])));
}

const ROUND_COLS = "key, played_at, build, tsum, skill, skill_type, items, version, settings, duration, score, base, final, medals";

/** The dataset, with contributor 2 banned and some of contributor 1's rounds already unlinked (contributor 0). */
async function archived(later: Env = DROP) {
  const { people } = await dataset(2, 3);
  await admin("ban", { id: people[2].id });
  await env.DB.prepare("UPDATE rounds SET contributor = 0 WHERE contributor = ?1 AND substr(key, 18, 1) IN ('0', '1', '2', '3', '4', '5', '6', '7')")
    .bind(people[1].id).run();
  await rollup();
  const before = {
    rounds: await rows<RoundRow & { version: string; settings: number }>(`SELECT contributor, ${ROUND_COLS} FROM rounds ORDER BY key`),
    bins: await rows("SELECT key, bin_base, bin_final, bin_medals FROM rounds ORDER BY key"),
    tables: await tables(),
    manifest: await r2json("data/global/manifest.json"),
  };
  const reports = await rollup(LATER, later);
  return { people, before, reports };
}

/**
 * Rounds of `day` straight into D1, `players` contributors with `each`
 * rounds apiece, and nothing else: for the archive, which reads only rounds.
 */
async function fillDay(day: string, players: number, each: number, first = 1) {
  const ids = Array.from({ length: players }, (_, i) => first + i);
  await env.DB.prepare(`INSERT OR IGNORE INTO contributors (id, key_hash, status, created_at) SELECT value, 'h' || value, 'active', 0 FROM json_each(?1)`)
    .bind(JSON.stringify(ids)).run();
  await env.DB.prepare("INSERT OR IGNORE INTO settings (id, hash, json) VALUES (1, 'h1', '{}')").run();
  const n = players * each, step = Math.floor(86400_000 / n);
  await env.DB.prepare(`WITH RECURSIVE g(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM g WHERE i < ?1 - 1)
    INSERT INTO rounds (key, contributor, played_at, build, tsum, skill, items, version, settings, duration, score, base, final, medals, bin_base, bin_final, bin_medals)
    SELECT printf('%012x', ?2 + i * ?3) || printf('%08x', i) || printf('%012x', 1000000 + i % ?4), ?5 + i % ?4, (?2 + i * ?3) / 1000 + 90,
      i % 2, 'mickey', 1 + i % 6, i % 4, '3.0b4', 1, 85.5, 1000000 + i, 2000 + i % 3000, 3000 + i % 4000, NULL, 100, 110, NULL FROM g`)
    .bind(n, dayStart(day) * 1000, step, players, first).run();
}

describe("archive and drop", () => {
  it("files each final day, one file per contributor, then drops it from D1", async () => {
    const { people, before, reports } = await archived();
    expect(reports.flatMap(r => r.archived)).toEqual(DAYS);
    expect(reports.flatMap(r => r.dropped)).toEqual(DAYS);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    expect(await one("SELECT value FROM state WHERE key = 'archived_through'")).toEqual({ value: "2026-10-14" });
    expect(await one("SELECT value FROM state WHERE key = 'dropped_through'")).toEqual({ value: "2026-10-14" });
    // The public figures and the contributors' record stay.
    expect(await tables()).toEqual(before.tables);

    const keys = await r2keys("archive/");
    let filed = 0;
    for (const day of DAYS) {
      const inDay = before.rounds.filter(r => keyDay(r.key) === day);
      for (const p of people) {
        const f = (await r2json<ArchiveFile>(archiveKey(day, `c${p.id}.json`)))!;
        expect(f).toMatchObject({ kind: "tsum-global-archive", format: 2, day, contributor: p.id });
        const mine = inDay.filter(r => r.contributor === p.id).map(({ contributor: _, ...r }) => r);
        expect(fileRows(f)).toEqual(mine);
        filed += f.n;
      }
      const unlinked = keys.filter(k => k.startsWith(archiveKey(day, "u")));
      expect(unlinked).toHaveLength(1);
      const u = (await r2json<ArchiveFile>(unlinked[0]))!;
      expect(u.contributor).toBeNull();
      expect(fileRows(u)).toEqual(inDay.filter(r => r.contributor === 0).map(({ contributor: _, ...r }) => r));
      filed += u.n;
    }
    expect(filed).toBe(before.rounds.length);

    // Every settings row an archived round names is in archive/settings/.
    const settingsFiles = keys.filter(k => k.startsWith("archive/settings/"));
    expect(settingsFiles).toHaveLength(1);
    const s = (await r2json<{ kind: string; format: number; settings: { id: number; hash: string; json: string }[] }>(settingsFiles[0]))!;
    expect(s.kind).toBe("tsum-global-settings");
    expect(s.settings).toEqual(await rows("SELECT id, hash, json FROM settings ORDER BY id"));
    expect(settingsFiles[0]).toBe(`archive/settings/${s.settings[0].id}-${s.settings.at(-1)!.id}.json`);
    expect(new Set(before.rounds.map(r => r.settings)).size).toBeLessThanOrEqual(s.settings.length);

    // Nothing more to do until the next day is final.
    const [next] = await rollup(LATER + 3600_000, DROP);
    expect(next).toMatchObject({ archived: [], dropped: [], more: false });
  });

  it("keeps archived days in D1 until it holds more than RETAIN_ROWS, then drops the oldest first", async () => {
    const { before, reports } = await archived(env);
    // A small deployment never pays for the deletes.
    expect(reports.flatMap(r => r.archived)).toEqual(DAYS);
    expect(reports.flatMap(r => r.dropped)).toEqual([]);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: before.rounds.length });
    const held = JSON.parse((await one<{ value: string }>("SELECT value FROM state WHERE key = 'held'")).value) as [string, number][];
    expect(held.map(([d]) => d)).toEqual(DAYS);
    expect(held.reduce((n, [, r]) => n + r, 0)).toBe(before.rounds.length);
    // Late rounds of an archived day are still old.
    const late = await upload((await joinNew(LATER)).key, [record({ at: Date.UTC(2026, 9, 13, 12) })], LATER);
    expect(late.body.rejected).toEqual({ old: 1 });

    // Past RETAIN_ROWS, the oldest days go until D1 holds no more than it.
    const keep = before.rounds.filter(r => keyDay(r.key) === "2026-10-14").length;
    const [r] = await rollup(LATER + 3600_000, { ...env, RETAIN_ROWS: String(keep) });
    expect(r.dropped).toEqual(["2026-10-12", "2026-10-13"]);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: keep });
    expect(await tables()).toEqual(before.tables);
  });

  it("counts the archive's writes, deletes too, in the day's budget, and puts off the deletes when it is short", async () => {
    await dataset(2, 3);
    await rollup();
    const k = counted(DROP);
    const day = new Date(LATER).toISOString().slice(0, 10);
    const runs = await rollup(LATER, k.env);
    expect(runs.flatMap(r => r.dropped)).toEqual(DAYS);
    const spent = await one<{ rows: number }>("SELECT rows FROM budget WHERE day = ?1", day);
    expect(spent.rows).toBe(k.n.written);
    // The deletes are rows written.
    const dropped = [...k.n.bySql].filter(([sql]) => sql.startsWith("DELETE FROM rounds")).reduce((n, [, e]) => n + e.written, 0);
    expect(dropped).toBeGreaterThan(500);

    // With today's budget nearly spent (past 85,000 of 90,000 the job keeps
    // the rest for what cannot wait), archiving goes on but the deletes wait.
    await wipe();
    await fillDay("2026-08-10", 3, 1000);
    await env.DB.prepare("INSERT INTO state (key, value) VALUES ('archived_through', '2026-08-09')").run();
    const now = Date.UTC(2026, 9, 14, 0, 30);
    const full = { ...DROP, BUDGET_ROWS_PER_DAY: "90000" };
    await env.DB.prepare("INSERT INTO budget (day, rows) VALUES ('2026-10-14', 84000)").run();
    const late = await rollup(now, full, 5);
    expect(late.flatMap(r => r.archived)).toContain("2026-08-10");
    expect(late.flatMap(r => r.dropped)).toEqual([]);
    expect(late.at(-1)!.more).toBe(true);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 3000 });
    // The next day it has room again.
    const next = await rollup(now + 86400_000, full);
    expect(next.flatMap(r => r.dropped)).toEqual(["2026-08-10"]);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
  });

  it("archives a day from one scan of its rounds, however many contributors sent them", async () => {
    const day = "2026-08-10";
    await fillDay(day, 8, 200);
    await fillDay("2026-08-11", 2, 10, 9);
    const k = counted();
    const now = Date.UTC(2026, 9, 14, 0, 30);
    await env.DB.prepare("INSERT INTO state (key, value) VALUES ('archived_through', '2026-08-09')").run();
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const r = await runJob(k.env, now + i * 3600_000);
      runs.push(r);
      if (r.archived.includes(day)) break;
    }
    expect(runs.flatMap(r => r.archived)).toContain(day);
    // The 1,600 rounds are read about twice in all (the scan, and sorting it
    // by contributor), not once per contributor (8 times or more).
    const archiveReads = [...k.n.bySql].filter(([sql]) => sql.includes("FROM rounds") || sql.includes("archive_parts")).reduce((n, [, e]) => n + e.read, 0);
    expect(archiveReads).toBeGreaterThanOrEqual(1600);
    expect(archiveReads).toBeLessThan(3 * 1600);
    for (let c = 1; c <= 8; c++) expect((await r2json<ArchiveFile>(archiveKey(day, `c${c}.json`)))!.n).toBe(200);
  });

  it("splits a big day of one contributor into files under the value limit, and restores every one", async () => {
    const day = "2026-08-10";
    await fillDay(day, 2, 1500);
    await env.DB.prepare("INSERT INTO state (key, value) VALUES ('archived_through', '2026-08-09')").run();
    const before = await rows(`SELECT contributor, ${ROUND_COLS} FROM rounds ORDER BY key`);
    // Files of at most about 60 kB, and a D1 that refuses any value over 100 kB.
    const small = counted({ ...DROP, VALUE_MAX_BYTES: "60000", RUN_BYTES: "200000" }, { valueMax: 100_000 });
    const now = Date.UTC(2026, 9, 14, 0, 30);
    for (let i = 0; i < 30; i++) {
      const r = await runJob(small.env, now + i * 3600_000);
      expect(r.errors).toEqual([]);
      if (r.dropped.includes(day)) break;
    }
    const files = await r2keys(archiveKey(day, ""));
    expect(files.length).toBeGreaterThan(4);
    expect(files.filter(f => /\/c1\./.test(f)).length).toBeGreaterThan(2);
    let n = 0;
    for (const f of files) {
      const obj = (await env.BUCKET.get(f))!;
      const text = await obj.text();
      expect(text.length, f).toBeLessThan(100_000);
      n += (JSON.parse(text) as ArchiveFile).n;
    }
    expect(n).toBe(3000);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    // Restored, every file is back, under its contributor.
    for (let i = 0; i < 20; i++) {
      const b = await json<{ done: boolean }>(call("/api/v1/admin/restore", { body: { day }, key: ADMIN, now: now + 40 * 3600_000 }));
      if (b.done) break;
    }
    expect(await rows(`SELECT contributor, ${ROUND_COLS} FROM rounds ORDER BY key`)).toEqual(before);
  });

  it("archives the settings in files under the value limit", async () => {
    const c = await joinNew(NOW);
    // 40 settings objects of about 3 kB each.
    const recs = Array.from({ length: 40 }, (_, i) => record({ at: NOW - 3600_000 - i * 60_000, extra: { note: String(i).padStart(250, "x"),
      ...Object.fromEntries(Array.from({ length: 10 }, (_, j) => [`n${j}`, "y".repeat(250)])) } }));
    expect((await upload(c.key, recs)).body.accepted).toBe(40);
    await rollup();
    await rollup(LATER, counted({ ...DROP, VALUE_MAX_BYTES: "30000" }, { valueMax: 40_000 }).env);
    const files = await r2keys("archive/settings/");
    expect(files.length).toBeGreaterThan(3);
    let ids = 0;
    for (const f of files) {
      const text = await (await env.BUCKET.get(f))!.text();
      expect(text.length).toBeLessThan(40_000);
      ids += (JSON.parse(text) as { settings: unknown[] }).settings.length;
    }
    expect(ids).toBe(40);
  });

  it("archives a day over several runs when the budget is tight", async () => {
    const { people } = await dataset(1, 5);
    await rollup();
    const tight = counted({ ...DROP, RUN_QUERY_BUDGET: "22", RUN_R2_BUDGET: "6" });
    const runs = await rollup(LATER, tight.env);
    expect(runs.length).toBeGreaterThan(2);
    expect(runs.flatMap(r => r.archived)).toEqual(["2026-10-13", "2026-10-14"]);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    for (const p of people) expect(await env.BUCKET.head(archiveKey("2026-10-14", `c${p.id}.json`))).not.toBeNull();
  });

  it("files every round once when a merge comes in the middle of a day's archive", async () => {
    const { people } = await dataset(1, 9);
    await rollup();
    const day = "2026-10-14";
    const keys = await rows<{ key: string }>("SELECT key FROM rounds WHERE key >= ?1", dayRange(day).lo);
    // Room for a file or two a run.
    const tight = { ...DROP, RUN_QUERY_BUDGET: "18", RUN_R2_BUDGET: "6", RUN_BYTES: "1000" };
    let progress: { day: string; done: number; files: unknown[] | null } | undefined;
    for (let i = 0; i < 12; i++) {
      await rollup(LATER, tight, 1);
      const v = (await rows<{ value: string }>("SELECT value FROM state WHERE key = 'archive'"))[0];
      progress = v && JSON.parse(v.value);
      if (progress?.day === day && progress.done > 0) break;
    }
    expect(progress).toMatchObject({ day });
    expect(progress!.done).toBeGreaterThan(0);
    expect(progress!.done).toBeLessThan(progress!.files!.length);
    // A merge moves rounds after some files were written.
    await admin("merge", { from: people[0].id, into: people[1].id }, LATER);
    await rollup(LATER, DROP);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    expect(await one("SELECT count(*) AS n FROM archive_parts")).toEqual({ n: 0 });
    // The day's files hold every round once, the merged one's under its own
    // id, which a restore files under the one it was merged into.
    const files = await Promise.all((await r2keys(archiveKey(day, ""))).map(f => r2json<ArchiveFile>(f)));
    const all = files.flatMap(f => f!.key);
    expect(all.sort()).toEqual(keys.map(k => k.key).sort());
    expect(files.map(f => f!.contributor).sort()).toEqual([people[0].id, people[1].id, people[2].id].sort());
    await admin("restore", { day }, LATER);
    expect((await rows<{ contributor: number }>("SELECT DISTINCT contributor FROM rounds ORDER BY contributor")).map(r => r.contributor))
      .toEqual([people[1].id, people[2].id]);
  });
});

describe("restore", () => {
  it("reads a day back to the same cells, then drops it again", async () => {
    const { people, before } = await archived();
    const day = "2026-10-13";
    const res = await admin("restore", { day }, LATER);
    const body = await json(res);
    const back = before.rounds.filter(r => keyDay(r.key) === day);
    expect(body).toEqual({ ok: true, day, done: true, files: people.length + 1, left: 0, rounds: back.length });
    expect(await rows(`SELECT contributor, ${ROUND_COLS} FROM rounds ORDER BY key`)).toEqual(back);
    await checkAgainstReference(new Set([people[2].id]), new Set(), [day]);

    const [r] = await rollup(LATER, DROP);
    expect(r.recomputed).toEqual([day]);
    expect(r.rendered).toEqual([]);
    expect(r.dropped).toEqual([day]);
    expect(await tables()).toEqual(before.tables);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    expect(await one("SELECT value FROM state WHERE key = 'restored'")).toEqual({ value: "[]" });
  });

  it("reads a format 1 file, from before skill types were kept, back with skill type unknown", async () => {
    const { people, before } = await archived();
    const day = "2026-10-13";
    // Every file of the day as format 1 wrote it: no skillType array.
    for (const key of await r2keys(archiveKey(day, ""))) {
      const { skillType: _, ...old } = (await r2json<ArchiveFile>(key))!;
      await env.BUCKET.put(key, JSON.stringify({ ...old, format: 1 }));
    }
    const body = await json(admin("restore", { day }, LATER));
    const back = before.rounds.filter(r => keyDay(r.key) === day);
    expect(body).toMatchObject({ done: true, files: people.length + 1, rounds: back.length });
    expect(await rows(`SELECT contributor, ${ROUND_COLS} FROM rounds ORDER BY key`)).toEqual(back.map(r => ({ ...r, skill_type: "" })));
  });

  it("only marks a day dirty when its rounds are still in D1", async () => {
    const { before } = await archived(env);
    const res = await json(admin("restore", { day: "2026-10-13" }, LATER));
    expect(res).toEqual({ ok: true, day: "2026-10-13", done: true, files: 0, left: 0, rounds: 0 });
    const [r] = await rollup(LATER);
    expect(r.recomputed).toEqual(["2026-10-13"]);
    expect(await tables()).toEqual(before.tables);
  });

  it("gives back the same bins it made at ingest", async () => {
    const { before } = await archived();
    for (const day of DAYS) await admin("restore", { day }, LATER);
    // SQL's bins of the archived figures are JavaScript's from ingest.
    expect(await rows("SELECT key, bin_base, bin_final, bin_medals FROM rounds ORDER BY key")).toEqual(before.bins);
    await rollup(LATER, DROP);
    expect(await tables()).toEqual(before.tables);
  });

  it("restores over several calls when the budget is tight, and only archived days", async () => {
    const { people } = await archived();
    expect((await admin("restore", { day: "2026-10-15" }, LATER)).status).toBe(400);
    expect((await admin("restore", { day: "13 Oct" }, LATER)).status).toBe(400);
    const tight = { ...env, RUN_QUERY_BUDGET: "11", RUN_R2_BUDGET: "2" };
    const calls = [];
    for (let i = 0; i < 10; i++) {
      const res = await call("/api/v1/admin/restore", { body: { day: "2026-10-14" }, key: ADMIN, env: tight, now: LATER });
      const b = await json<{ done: boolean; files: number; left: number }>(res);
      calls.push(b);
      if (b.done) break;
    }
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.reduce((n, c) => n + c.files, 0)).toBe(people.length + 1);
    // Until the last file is back, the day is not recomputed.
    expect(await one("SELECT count(*) AS n FROM dirty_days")).toEqual({ n: 1 });
  });

  it("stops restoring when the day's write budget is spent, and goes on later", async () => {
    const { before } = await archived();
    const day = "2026-10-14";
    const today = new Date(LATER).toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO budget (day, rows) VALUES (?1, 89000) ON CONFLICT (day) DO UPDATE SET rows = 89000").bind(today).run();
    const first = await json<{ done: boolean; files: number }>(call("/api/v1/admin/restore", { body: { day }, key: ADMIN, now: LATER }));
    expect(first).toMatchObject({ done: false, files: 0 });
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    const next = await json<{ done: boolean }>(call("/api/v1/admin/restore", { body: { day }, key: ADMIN, now: LATER + DAY_MS }));
    expect(next.done).toBe(true);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: before.rounds.filter(r => keyDay(r.key) === day).length });
  });

  it("lists the day again when an unlink renames a file mid-restore", async () => {
    const { people, before } = await archived();
    const day = "2026-10-14";
    const want = before.rounds.filter(r => keyDay(r.key) === day).length;
    // Room for one file a call.
    const tight = { ...env, RUN_QUERY_BUDGET: "10", RUN_R2_BUDGET: "3" };
    const first = await json<{ done: boolean; files: number }>(
      call("/api/v1/admin/restore", { body: { day }, key: ADMIN, env: tight, now: LATER }));
    expect(first).toMatchObject({ done: false, files: 1 });
    // people[1]'s file is still to be read when the unlink renames it.
    await call("/api/v1/me/unlink", { method: "POST", key: people[1].key, now: LATER });
    await rollup(LATER, { ...env, UNLINK_CHUNK: "100000" });
    expect(await env.BUCKET.head(archiveKey(day, `c${people[1].id}.json`))).toBeNull();
    for (let i = 0; i < 10; i++) {
      const b = await json<{ done: boolean }>(call("/api/v1/admin/restore", { body: { day }, key: ADMIN, now: LATER }));
      if (b.done) break;
    }
    expect(await one("SELECT count(*) AS n FROM rounds WHERE key >= ?1", dayRange(day).lo)).toEqual({ n: want });
  });

  it("files a merged contributor's archive under the one it was merged into", async () => {
    const { people, before } = await archived();
    await admin("merge", { from: people[0].id, into: people[1].id }, LATER);
    await admin("restore", { day: "2026-10-14" }, LATER);
    const owners = await rows<{ contributor: number }>("SELECT DISTINCT contributor FROM rounds ORDER BY contributor");
    expect(owners.map(o => o.contributor)).toEqual([0, people[1].id, people[2].id]);
    await rollup(LATER, DROP);
    // The public cells are the same; the record of who sent what moved.
    expect((await tables()).cells).toEqual(before.tables.cells);
    expect(await one("SELECT count(*) AS n FROM contrib_cells WHERE contributor = ?1", people[0].id)).toEqual({ n: 0 });
  });
});

describe("compaction", () => {
  it("turns a final month's day parts into one month part", async () => {
    await dataset(2, 21);
    await rollup();
    const dayParts = (await r2json<{ parts: { file: string }[] }>("data/global/manifest.json"))!.parts;
    expect(dayParts).toHaveLength(3);
    const cells = (await tables()).cells;

    const JAN = Date.UTC(2027, 0, 2, 12);
    const reports = await rollup(JAN, DROP);
    expect(reports.flatMap(r => r.compacted)).toEqual(["2026-10"]);
    const m = (await r2json<{ parts: { from: string; to: string; file: string; rounds: number }[]; rounds: number }>("data/global/manifest.json"))!;
    expect(m.parts).toHaveLength(1);
    expect(m.parts[0]).toMatchObject({ from: "2026-10-01", to: "2026-11-01", rounds: m.rounds });
    expect(m.parts[0].file).toMatch(/^month-2026-10\.[0-9a-f]{8}\.json$/);
    const part = (await r2json<{ from: string; to: string; cells: { n: number; day: string[] } }>("data/global/" + m.parts[0].file))!;
    expect(part).toMatchObject({ from: "2026-10-01", to: "2026-11-01" });
    expect(part.cells.n).toBe(cells.length);
    expect(new Set(part.cells.day)).toEqual(new Set(["2026-10-12", "2026-10-13", "2026-10-14"]));

    // The day parts wait out a cached manifest, then go.
    for (const p of dayParts) expect(await env.BUCKET.head("data/global/" + p.file)).not.toBeNull();
    await rollup(JAN + 20 * 60_000, DROP);
    expect(await r2keys("data/global/")).toEqual(["data/global/manifest.json", "data/global/" + m.parts[0].file].sort());

    // A restored day of the month re-renders the month part: the same file.
    await admin("restore", { day: "2026-10-13" }, JAN);
    const [r] = await rollup(JAN + 21 * 60_000, DROP);
    expect(r).toMatchObject({ recomputed: ["2026-10-13"], rendered: [], dropped: ["2026-10-13"] });
    expect((await r2json<{ parts: unknown[] }>("data/global/manifest.json"))!.parts).toEqual(m.parts);
  });

  it("leaves a month too big for one part in day parts, without building it", async () => {
    await dataset(2, 21);
    await rollup();
    const dayParts = (await r2json<{ parts: { file: string }[] }>("data/global/manifest.json"))!.parts;
    const bytes = (await Promise.all(dayParts.map(async p => (await env.BUCKET.head("data/global/" + p.file))!.size))).reduce((a, b) => a + b, 0);
    // The month's day parts add up to more than one value may hold: it is
    // never asked of D1, which would refuse it.
    const k = counted({ ...DROP, VALUE_MAX_BYTES: String(Math.floor(bytes * 0.8)) }, { valueMax: Math.floor(bytes * 0.9) });
    const JAN = Date.UTC(2027, 0, 2, 12);
    const reports = await rollup(JAN, k.env);
    expect(reports.flatMap(r => r.errors)).toEqual([]);
    expect(reports.flatMap(r => r.compacted)).toEqual([]);
    expect(await one("SELECT value FROM state WHERE key = 'nocompact:2026-10'")).toEqual({ value: String(bytes) });
    expect((await r2json<{ parts: { file: string }[] }>("data/global/manifest.json"))!.parts).toEqual(dayParts);
    // Later runs go on as usual.
    expect((await rollup(JAN + 3600_000, k.env)).at(-1)).toMatchObject({ errors: [], more: false });
    expect(D1_VALUE_MAX).toBe(2_000_000);
  });
});
