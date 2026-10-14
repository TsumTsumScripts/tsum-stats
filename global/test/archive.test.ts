// Archive and drop, restore, and month compaction (CONTRACT §3.2 steps 4-5, §3.4).
import { beforeEach, describe, expect, it } from "vitest";
import { archiveKey } from "../src/archive";
import { dayRange, keyDay } from "../src/days";
import { ADMIN, DAY_MS, NOW, admin, call, env, json, one, r2json, r2keys, rollup, rows, wipe } from "./helpers";
import { checkAgainstReference, counted, dataset, tables, type RoundRow } from "./reference";

beforeEach(wipe);

/** Two months on: every day of the dataset is final. */
const LATER = NOW + 62 * DAY_MS;
const DAYS = ["2026-10-12", "2026-10-13", "2026-10-14"];

interface ArchiveFile {
  kind: string; format: number; day: string; contributor: number | null; n: number;
  key: string[]; playedAt: number[]; build: number[]; tsum: string[]; skill: number[]; items: number[]; version: string[];
  settings: number[]; duration: number[]; score: number[]; base: number[]; final: number[]; medals: (number | null)[];
}

/** An archive file back into rounds rows, checking its arrays line up. */
function fileRows(f: ArchiveFile): Record<string, unknown>[] {
  const cols: [string, keyof ArchiveFile][] = [["key", "key"], ["played_at", "playedAt"], ["build", "build"], ["tsum", "tsum"],
    ["skill", "skill"], ["items", "items"], ["version", "version"], ["settings", "settings"], ["duration", "duration"],
    ["score", "score"], ["base", "base"], ["final", "final"], ["medals", "medals"]];
  for (const [, c] of cols) expect(f[c], c).toHaveLength(f.n);
  return Array.from({ length: f.n }, (_, i) => Object.fromEntries(cols.map(([name, c]) => [name, (f[c] as unknown[])[i]])));
}

const ROUND_COLS = "key, played_at, build, tsum, skill, items, version, settings, duration, score, base, final, medals";

/** The dataset, with contributor 2 banned and some of contributor 1's rounds already unlinked (contributor 0). */
async function archived() {
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
  const reports = await rollup(LATER);
  return { people, before, reports };
}

describe("archive and drop", () => {
  it("files each final day, one file per contributor, then drops it from D1", async () => {
    const { people, before, reports } = await archived();
    expect(reports.flatMap(r => r.archived)).toEqual(DAYS);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    expect(await one("SELECT value FROM state WHERE key = 'archived_through'")).toEqual({ value: "2026-10-14" });
    // The public figures and the contributors' record stay.
    expect(await tables()).toEqual(before.tables);

    const keys = await r2keys("archive/");
    let filed = 0;
    for (const day of DAYS) {
      const inDay = before.rounds.filter(r => keyDay(r.key) === day);
      for (const p of people) {
        const f = (await r2json<ArchiveFile>(archiveKey(day, `c${p.id}.json`)))!;
        expect(f).toMatchObject({ kind: "tsum-global-archive", format: 1, day, contributor: p.id });
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
    const [next] = await rollup(LATER + 3600_000);
    expect(next).toMatchObject({ archived: [], more: false });
  });

  it("archives a day over several runs when the budget is tight", async () => {
    const { people } = await dataset(1, 5);
    await rollup();
    const tight = counted({ ...env, RUN_QUERY_BUDGET: "22", RUN_R2_BUDGET: "8" });
    const runs = await rollup(LATER, tight.env);
    expect(runs.length).toBeGreaterThan(2);
    expect(runs.flatMap(r => r.archived)).toEqual(["2026-10-13", "2026-10-14"]);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    for (const p of people) expect(await env.BUCKET.head(archiveKey("2026-10-14", `c${p.id}.json`))).not.toBeNull();
  });

  it("starts a day over when its rows changed between runs", async () => {
    const { people } = await dataset(1, 9);
    await rollup();
    const keys = await rows<{ key: string }>("SELECT key FROM rounds WHERE key >= ?1", dayRange("2026-10-14").lo);
    const tight = { ...env, RUN_QUERY_BUDGET: "18", RUN_R2_BUDGET: "6" };
    const [first] = await rollup(LATER, tight, 1);
    expect(first.more).toBe(true);
    const progress = await one<{ value: string }>("SELECT value FROM state WHERE key = 'archive'");
    expect(JSON.parse(progress.value).done.length).toBeGreaterThan(0);
    // A merge moves rounds after some files were written.
    await admin("merge", { from: people[0].id, into: people[1].id }, LATER);
    await rollup(LATER);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    // The files written after the merge hold every round once; an earlier
    // c<from>.json may still be there, and a restore files it under `into`.
    const day = "2026-10-14";
    const merged = (await r2json<ArchiveFile>(archiveKey(day, `c${people[1].id}.json`)))!;
    const third = (await r2json<ArchiveFile>(archiveKey(day, `c${people[2].id}.json`)))!;
    expect(new Set([...merged.key, ...third.key]).size).toBe(merged.n + third.n);
    expect([...merged.key, ...third.key].sort()).toEqual(keys.map(k => k.key).sort());
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

    const [r] = await rollup(LATER);
    expect(r.recomputed).toEqual([day]);
    expect(r.rendered).toEqual([]);
    expect(r.dropped).toEqual([day]);
    expect(await tables()).toEqual(before.tables);
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
    expect(await one("SELECT value FROM state WHERE key = 'restored'")).toEqual({ value: "[]" });
  });

  it("gives back the same bins it made at ingest", async () => {
    const { before } = await archived();
    for (const day of DAYS) await admin("restore", { day }, LATER);
    // SQL's bins of the archived figures are JavaScript's from ingest.
    expect(await rows("SELECT key, bin_base, bin_final, bin_medals FROM rounds ORDER BY key")).toEqual(before.bins);
    await rollup(LATER);
    expect(await tables()).toEqual(before.tables);
  });

  it("restores over several calls when the budget is tight, and only archived days", async () => {
    const { people } = await archived();
    expect((await admin("restore", { day: "2026-10-15" }, LATER)).status).toBe(400);
    expect((await admin("restore", { day: "13 Oct" }, LATER)).status).toBe(400);
    const tight = { ...env, RUN_QUERY_BUDGET: "9", RUN_R2_BUDGET: "2" };
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

  it("lists the day again when an unlink renames a file mid-restore", async () => {
    const { people, before } = await archived();
    const day = "2026-10-14";
    const want = before.rounds.filter(r => keyDay(r.key) === day).length;
    // Room for one file a call.
    const tight = { ...env, RUN_QUERY_BUDGET: "7", RUN_R2_BUDGET: "3" };
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
    await rollup(LATER);
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
    const reports = await rollup(JAN);
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
    await rollup(JAN + 20 * 60_000);
    expect(await r2keys("data/global/")).toEqual(["data/global/manifest.json", "data/global/" + m.parts[0].file].sort());

    // A restored day of the month re-renders the month part: the same file.
    await admin("restore", { day: "2026-10-13" }, JAN);
    const [r] = await rollup(JAN + 21 * 60_000);
    expect(r).toMatchObject({ recomputed: ["2026-10-13"], rendered: [], dropped: ["2026-10-13"] });
    expect((await r2json<{ parts: unknown[] }>("data/global/manifest.json"))!.parts).toEqual(m.parts);
  });
});
