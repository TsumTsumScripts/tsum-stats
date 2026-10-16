// The hourly job's recompute and render (CONTRACT §3.2 steps 1, 2, 6; §4).
import { beforeEach, describe, expect, it } from "vitest";
import { MEDAL_TSUMS, TSUMS, isMedalTsum } from "../src/catalog";
import { sha256Hex } from "../src/crypto";
import { dayOf, keyDay } from "../src/days";
import { runJob } from "../src/job";
import {
  DAY_MS, NOW, admin, call, env, joinNew, one, r2json, r2keys, record, rollup, rows, series, upload, wipe,
} from "./helpers";
import { CELL_KEY, BIN_KEY, checkAgainstReference, counted, dataset, sameRows, tables } from "./reference";
import { createGlobalEngine } from "../../ui/src/lib/global/engine.js";

beforeEach(wipe);

interface Manifest {
  kind: string; format: number; generatedAt: string; rounds: number; contributors: number; devices: number;
  first: string | null; last: string | null; parts: { from: string; to: string; file: string; rounds: number; sha: string }[];
  tsums: { tsum: string; rounds: number; contributors: number }[]; medalTsums: string[]; skills: number[]; minContributors: number;
  playSettings: Record<"scan" | "chain" | "bubble", { value: string; rounds: number }[]>;
}
type Columns = Record<string, unknown[]> & { n: number };
interface PartFile { kind: string; format: number; from: string; to: string; cells: Columns; bins: Columns }

const manifest = async () => (await r2json<Manifest>("data/global/manifest.json"))!;

/** A part's columns back into rows, in the tables' column names. */
function partRows(cols: Columns): Record<string, unknown>[] {
  const names = Object.keys(cols).filter(k => k !== "n");
  for (const k of names) expect(cols[k], k).toHaveLength(cols.n);
  const snake = (k: string) => k.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
  return Array.from({ length: cols.n }, (_, i) => Object.fromEntries(names.map(k => [snake(k), cols[k][i]])));
}

describe("recompute", () => {
  it("rolls each day up as a plain JS reference does", async () => {
    const { people } = await dataset(3);
    // Some rounds last hours, and some of those end on the day after they began.
    const spans = await rows<{ key: string; played_at: number; duration: number }>("SELECT key, played_at, duration FROM rounds");
    expect(spans.some(r => r.duration > 3600 && keyDay(r.key) !== dayOf(r.played_at))).toBe(true);
    await admin("ban", { id: people[2].id });
    const reports = await rollup();
    expect(reports.at(-1)!.more).toBe(false);
    expect(reports.flatMap(r => r.recomputed).sort()).toEqual(["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]);
    const want = await checkAgainstReference(new Set([people[2].id]));
    expect(want.cells.length).toBeGreaterThan(100);
    // Banned rounds are in contrib_cells, not in the cells.
    expect(want.contrib.some(c => c.contributor === people[2].id)).toBe(true);
    const cellRounds = want.cells.reduce((n, c) => n + c.rounds, 0);
    expect(cellRounds).toBe((await one<{ n: number }>("SELECT count(*) AS n FROM rounds WHERE contributor != ?1", people[2].id)).n);

    // The manifest adds the parts up.
    const m = await manifest();
    const first = Math.min(...want.cells.map(c => c.first!)), last = Math.max(...want.cells.map(c => c.last!));
    expect(m).toMatchObject({
      kind: "tsum-global", format: 1, generatedAt: "2026-10-14T18:00:00Z", rounds: cellRounds,
      contributors: 2, devices: 6, minContributors: 3, medalTsums: MEDAL_TSUMS,
      first: new Date(first * 1000).toISOString().replace("T", " ").slice(0, 19),
      last: new Date(last * 1000).toISOString().replace("T", " ").slice(0, 19),
      skills: [...new Set(want.cells.map(c => c.skill).filter(s => s >= 0))].sort((a, b) => a - b),
    });
    const perTsum = new Map<string, number>();
    for (const c of want.cells) perTsum.set(c.tsum, (perTsum.get(c.tsum) ?? 0) + c.rounds);
    expect(m.tsums).toEqual([...perTsum].map(([tsum, rounds]) => ({ tsum, rounds, contributors: 2 }))
      .sort((a, b) => b.rounds - a.rounds || (a.tsum < b.tsum ? -1 : 1)));
    // Each play setting's values, by rounds, not recorded left out.
    const values = (col: "scan" | "chain" | "bubble", known: (v: number | string) => boolean) => {
      const n = new Map<string, number>();
      for (const c of want.cells) if (known(c[col])) n.set(String(c[col]), (n.get(String(c[col])) ?? 0) + c.rounds);
      return [...n].map(([value, rounds]) => ({ value, rounds })).sort((a, b) => b.rounds - a.rounds || (a.value < b.value ? -1 : 1));
    };
    expect(m.playSettings).toEqual({
      scan: values("scan", v => (v as number) >= 0), chain: values("chain", v => (v as number) >= 0), bubble: values("bubble", v => v !== ""),
    });
    expect(m.playSettings.scan.map(v => v.value).sort()).toEqual(["12", "2", "3", "6"]);
    expect(m.parts.map(p => [p.from, p.to])).toEqual([
      ["2026-10-11", "2026-10-12"], ["2026-10-12", "2026-10-13"], ["2026-10-13", "2026-10-14"], ["2026-10-14", "2026-10-15"],
    ]);
  });

  it("files a round under the day it started, however long it lasted", async () => {
    const c = await joinNew();
    const midnight = Date.UTC(2026, 9, 14);
    const res = await upload(c.key, [
      // Began 29 minutes before midnight, ended after it.
      record({ at: midnight + 30_000, took: 29 * 60 + 30 }),
      // Began a minute before midnight and lasted three hours.
      record({ at: midnight + 3 * 3600_000 - 60_000, took: 3 * 3600, duration: 3 * 3600 - 20, tag: "0d0000000001" }),
      record({ at: midnight + 2 * 3600_000 }),
    ]);
    expect(res.body).toMatchObject({ accepted: 3, rejected: {} });
    await rollup();
    // A day's first and last are still its rounds' ends.
    expect(await rows("SELECT day, sum(rounds) AS n, min(first) AS first, max(last) AS last FROM cells2 GROUP BY day ORDER BY day")).toEqual([
      { day: "2026-10-13", n: 2, first: midnight / 1000 + 30, last: midnight / 1000 + 3 * 3600 - 60 },
      { day: "2026-10-14", n: 1, first: midnight / 1000 + 2 * 3600, last: midnight / 1000 + 2 * 3600 },
    ]);
    await checkAgainstReference(new Set());
  });

  it("brings a banned contributor back on unban", async () => {
    const a = await joinNew(), b = await joinNew();
    await upload(a.key, series(5));
    await upload(b.key, series(3, { tag: "0b0000000001" }));
    await rollup();
    const ban = await admin("ban", { id: b.id });
    expect(await ban.json()).toEqual({ ok: true, id: b.id, status: "banned", days: 1 });
    // A banned contributor still gets the same answers.
    expect((await upload(b.key, series(2, { tag: "0b0000000001", end: NOW - 600_000 }))).body).toMatchObject({ ok: true, accepted: 2 });
    await rollup();
    expect(await one("SELECT sum(rounds) AS n FROM cells2")).toEqual({ n: 5 });
    expect(await one("SELECT sum(rounds) AS n FROM contrib_cells WHERE contributor = ?1", b.id)).toEqual({ n: 5 });
    expect((await manifest()).contributors).toBe(1);
    await checkAgainstReference(new Set([b.id]));
    await admin("unban", { id: b.id });
    await rollup();
    expect(await one("SELECT sum(rounds) AS n FROM cells2")).toEqual({ n: 10 });
    expect((await manifest()).contributors).toBe(2);
  });

  it("writes only the rows that changed, and leaves an unchanged part alone", async () => {
    const c = await joinNew();
    await upload(c.key, series(20));
    await rollup();
    const before = await tables();
    const files = await r2keys("data/global/");

    await admin("rebuild", {});
    const k = counted();
    const [again] = await rollup(NOW, k.env);
    expect(again.recomputed).toEqual(["2026-10-14"]);
    expect(again.rendered).toEqual([]);
    const syncs = k.n.writes.filter(w => /^(INSERT INTO|DELETE FROM) (cells|cell_bins|contrib_cells)/.test(w.sql.trim()));
    expect(syncs).toHaveLength(6);
    expect(syncs.map(w => w.rows)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await tables()).toEqual(before);
    expect(await r2keys("data/global/")).toEqual(files);

    // One changed round rewrites its cell, and the cells it no longer fits are deleted.
    const moved = series(1, { end: NOW - 100_000, tsum: "minnie" });
    await upload(c.key, moved);
    await upload(c.key, [{ ...moved[0], tsum: "donald" }]);
    await rollup();
    expect(await rows("SELECT tsum, rounds FROM cells2 ORDER BY tsum")).toEqual([{ tsum: "donald", rounds: 1 }, { tsum: "mickey", rounds: 20 }]);
    expect(await rows("SELECT DISTINCT tsum FROM cell_bins2 ORDER BY tsum")).toEqual([{ tsum: "donald" }, { tsum: "mickey" }]);
  });

  it("leaves a day whose rounds have left D1 as it is", async () => {
    const c = await joinNew();
    await upload(c.key, series(3));
    await rollup();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rounds"),
      env.DB.prepare("INSERT INTO state (key, value) VALUES ('archived_through', '2026-10-14'), ('dropped_through', '2026-10-14')"),
      env.DB.prepare("INSERT INTO dirty_days (day) VALUES ('2026-10-14')"),
    ]);
    const before = await tables();
    const [r] = await rollup();
    expect(r.recomputed).toEqual([]);
    expect(await tables()).toEqual(before);
    expect(await one("SELECT count(*) AS n FROM dirty_days")).toEqual({ n: 0 });
  });
});

describe("render", () => {
  it("publishes parts whose arrays line up, named by their hash", async () => {
    await dataset(2, 11);
    await rollup();
    const m = await manifest();
    const { cells, bins } = await tables();
    for (const p of m.parts) {
      expect(p.file).toMatch(new RegExp(`^day-${p.from}\\.[0-9a-f]{8}\\.json$`));
      const obj = (await env.BUCKET.get("data/global/" + p.file))!;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const sha = (await sha256Hex(bytes)).slice(0, 8);
      expect(p.sha).toBe(sha);
      expect(p.file).toBe(`day-${p.from}.${sha}.json`);
      const part = JSON.parse(new TextDecoder().decode(bytes)) as PartFile;
      expect(part).toMatchObject({ kind: "tsum-global-part", format: 4, from: p.from, to: p.to });
      expect(Object.keys(part.cells)).toEqual(["n", "day", "build", "tsum", "skill", "skillType", "items", "scan", "chain", "bubble", "medal", "rounds", "secs",
        "scoreSum", "scoreMin", "scoreMax", "first", "last", "baseSum", "baseSq", "baseMin", "baseMax", "finalSum", "finalSq",
        "finalMin", "finalMax", "medalsN", "medalsSum", "medalsSq", "medalsMin", "medalsMax", "medalsSecs"]);
      expect(Object.keys(part.bins)).toEqual(["n", "day", "build", "tsum", "skill", "skillType", "items", "scan", "chain", "bubble", "medal", "base", "final", "medals"]);
      const dayCells = cells.filter(c => c.day === p.from);
      sameRows(partRows(part.cells), dayCells, CELL_KEY);
      sameRows(partRows(part.bins), bins.filter(b => b.day === p.from), BIN_KEY);
      expect(p.rounds).toBe(dayCells.reduce((n, c) => n + (c.rounds as number), 0));
    }
    // [from, to) days, sorted, never overlapping.
    for (let i = 1; i < m.parts.length; i++) expect(m.parts[i].from >= m.parts[i - 1].to).toBe(true);
  });

  it("deletes a replaced part once no cached manifest can still name it", async () => {
    const c = await joinNew();
    await upload(c.key, series(5));
    await rollup();
    const old = (await manifest()).parts[0].file;
    await upload(c.key, series(2, { end: NOW - 300_000 }), NOW + 60_000);
    const [r] = await rollup(NOW + 120_000);
    const now = (await manifest()).parts[0].file;
    expect(r.rendered).toEqual([now]);
    expect(now).not.toBe(old);
    expect(await r2keys("data/global/")).toEqual(["data/global/" + old, "data/global/" + now, "data/global/manifest.json"].sort());
    await rollup(NOW + 120_000 + 14 * 60_000);
    expect(await env.BUCKET.head("data/global/" + old)).not.toBeNull();
    await rollup(NOW + 120_000 + 16 * 60_000);
    expect(await r2keys("data/global/")).toEqual(["data/global/" + now, "data/global/manifest.json"].sort());
  });

  it("takes a day that lost all its rounds out of the manifest", async () => {
    const c = await joinNew();
    await upload(c.key, series(2));
    await rollup();
    await admin("ban", { id: c.id });
    const [r] = await rollup();
    expect(r.manifest).toBe(true);
    const m = await manifest();
    expect(m).toMatchObject({ rounds: 0, parts: [], tsums: [], skills: [], first: null, last: null, contributors: 0 });
  });

  it("writes the manifest when a part changed or it is missing, and not otherwise", async () => {
    const c = await joinNew();
    await upload(c.key, series(2));
    expect((await rollup())[0].manifest).toBe(true);
    expect((await rollup())[0].manifest).toBe(false);
    // A recompute that changes no part leaves it alone.
    await admin("rebuild", {});
    expect((await rollup())[0]).toMatchObject({ recomputed: ["2026-10-14"], manifest: false, rendered: [] });
    await env.BUCKET.delete("data/global/manifest.json");
    expect((await rollup())[0].manifest).toBe(true);
    expect(await manifest()).toMatchObject({ rounds: 2 });
    // The next day, its counts of people are made again.
    expect((await rollup(NOW + 7 * 3600_000))[0].manifest).toBe(true);
  });

  it("writes the manifest again on a later run when its put failed, and keeps the parts it names", async () => {
    const c = await joinNew();
    await upload(c.key, series(5));
    await rollup();
    const old = (await manifest()).parts[0].file;
    // The run that replaces the part cannot put the manifest.
    const failing = { ...env, BUCKET: new Proxy(env.BUCKET, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (k === "put") return (key: string, ...a: unknown[]) => key.endsWith("manifest.json") ? Promise.reject(new Error("R2 is down")) : v.call(t, key, ...a);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) };
    await upload(c.key, series(2, { end: NOW - 300_000 }), NOW + 60_000);
    await expect(runJob(failing, NOW + 120_000)).rejects.toThrow("R2 is down");
    expect((await manifest()).parts[0].file).toBe(old);
    // Hours later, with nothing new: the old part is still there, and the manifest is written again.
    const [r] = await rollup(NOW + 3600_000);
    expect(r.manifest).toBe(true);
    const now = (await manifest()).parts[0].file;
    expect(now).not.toBe(old);
    expect(await env.BUCKET.head("data/global/" + now)).not.toBeNull();
    expect(await env.BUCKET.head("data/global/" + old)).not.toBeNull();
    // Only once that manifest has been out for a while does the old part go.
    await rollup(NOW + 3600_000 + 16 * 60_000);
    expect(await env.BUCKET.head("data/global/" + old)).toBeNull();
    expect(await env.BUCKET.head("data/global/" + now)).not.toBeNull();
  });

  it("renders the manifest from running totals, without reading contrib_cells or every part's Tsums each run", async () => {
    // 40 days of three contributors, 30 Tsums a day.
    const people = [await joinNew(), await joinNew(), await joinNew()];
    const tsums = [...TSUMS].filter(t => !isMedalTsum(t)).slice(0, 30);
    for (let p = 0; p < 3; p++) {
      const recs = Array.from({ length: 40 * 30 }, (_, i) => record({
        at: NOW - 40 * DAY_MS + Math.floor(i / 30) * DAY_MS + (i % 30) * 60_000 + p * 3 * 3600_000, tsum: tsums[i % 30], tag: `0a00000000${p}0`,
      }));
      for (let i = 0; i < recs.length; i += 250) expect((await upload(people[p].key, recs.slice(i, i + 250))).status).toBe(200);
    }
    await rollup();
    const m = await manifest();
    expect(m.parts.length).toBe(41);
    expect(m.tsums).toHaveLength(30);
    // An hourly run with one new round: the manifest's query reads about its parts, not their cells or Tsums.
    await upload(people[0].key, series(1, { tag: "0a0000000000", end: NOW + 1800_000 }), NOW + 3600_000);
    const k = counted();
    const [r] = await rollup(NOW + 3600_000, k.env);
    expect(r.manifest).toBe(true);
    const manifestReads = [...k.n.bySql].filter(([sql]) => sql.startsWith("WITH p AS")).reduce((n, [, e]) => n + e.read, 0);
    expect(manifestReads).toBeGreaterThan(0);
    expect(manifestReads).toBeLessThan(15 * m.parts.length);
    expect([...k.n.bySql].some(([sql]) => sql.includes("contrib_cells WHERE day >= ?1 AND contributor != 0"))).toBe(false);
    // And it says the same as one made afresh.
    const fresh = await manifest();
    await env.DB.prepare("DELETE FROM state WHERE key IN ('totals', 'people')").run();
    await env.BUCKET.delete("data/global/manifest.json");
    await rollup(NOW + 3600_000);
    expect({ ...(await manifest()), generatedAt: "" }).toEqual({ ...fresh, generatedAt: "" });
  });
});

describe("limits", () => {
  it("splits a part too big for one value into several files, which the page adds up as one", async () => {
    await dataset(1, 17);
    await rollup();
    const engineAt = () => createGlobalEngine({
      async json(name: string) {
        const res = await call("/data/global/" + name);
        if (!res.ok) throw Object.assign(new Error(`${name}: ${res.status}`), { status: res.status });
        return res.json();
      },
    });
    const one = (await manifest()).parts.find(p => p.from === "2026-10-14")!;
    const whole = await engineAt().call("summary", {});
    const size = (await env.BUCKET.head("data/global/" + one.file))!.size;

    // Parts of at most a third of that, and a D1 that refuses a value half its size.
    await admin("rebuild", {});
    const k = counted({ ...env, VALUE_MAX_BYTES: String(Math.floor(size / 3)) }, { valueMax: Math.floor(size / 2) });
    const reports = await rollup(NOW, k.env);
    expect(reports.flatMap(r => r.errors)).toEqual([]);
    const m = await manifest();
    const files = m.parts.filter(p => p.from === "2026-10-14");
    expect(files.length).toBeGreaterThan(2);
    for (const f of files) {
      expect(f.to).toBe("2026-10-15");
      expect((await env.BUCKET.head("data/global/" + f.file))!.size).toBeLessThan(size / 2);
    }
    expect(files.reduce((n, f) => n + f.rounds, 0)).toBe(one.rounds);
    expect(await engineAt().call("summary", {})).toEqual(whole);
  });

  it("logs and reports a step that fails, and the other steps and the next runs go on", async () => {
    const c = await joinNew();
    await upload(c.key, series(4));
    // The unlink step's first query fails, every run.
    const broken = { ...env, DB: new Proxy(env.DB, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (k === "prepare") return (sql: string) => sql.includes("WHERE c.status IN ('unlinking', 'unlinking-banned')") ? t.prepare("SELECT nosuchcolumn FROM rounds") : t.prepare(sql);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) };
    const [r] = await rollup(NOW, broken, 1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^unlink: /);
    // The rounds were added in and published regardless.
    expect(r).toMatchObject({ folded: 4, manifest: true });
    expect((await manifest()).rounds).toBe(4);
    await upload(c.key, series(2, { end: NOW - 300_000 }));
    const [next] = await rollup(NOW + 3600_000, broken, 1);
    expect(next.folded).toBe(2);
    expect((await manifest()).rounds).toBe(6);
  });
});

describe("budget", () => {
  it("keeps every run within its D1 and R2 budget, and gets there over several runs", async () => {
    const c = await joinNew(NOW - 30 * DAY_MS);
    // A round every six hours for 30 days, then everything marked dirty.
    const recs = Array.from({ length: 120 }, (_, i) => record({ at: NOW - 30 * DAY_MS + i * 6 * 3600_000 }));
    for (let i = 0; i < recs.length; i += 50) await upload(c.key, recs.slice(i, i + 50));
    const k = counted();
    const runs = [];
    for (let i = 0; i < 20; i++) {
      k.reset();
      const r = await runJob(k.env, NOW);
      runs.push(r);
      expect(k.n.q, `run ${i}`).toBeLessThanOrEqual(45);
      expect(k.n.r2, `run ${i}`).toBeLessThanOrEqual(40);
      expect(r.queries).toBe(k.n.q);
      expect(r.r2).toBe(k.n.r2);
      expect(r.recomputed.length).toBeLessThanOrEqual(8);
      if (!r.more) break;
    }
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.at(-1)!.more).toBe(false);
    expect(runs.reduce((n, r) => n + r.folded, 0)).toBe(120);
    expect(new Set(runs.flatMap(r => r.rendered)).size).toBe(31);
    await checkAgainstReference(new Set());

    // A tighter budget still gets there, a day or so a run.
    await admin("rebuild", {});
    const tight = counted({ ...env, RUN_QUERY_BUDGET: "30", RUN_R2_BUDGET: "6" });
    let n = 0;
    for (let more = true; more && n < 60; n++) {
      tight.reset();
      more = (await runJob(tight.env, NOW)).more;
      expect(tight.n.q).toBeLessThanOrEqual(30);
      expect(tight.n.r2).toBeLessThanOrEqual(6);
    }
    expect(n).toBeGreaterThan(10);
    expect(await one("SELECT count(*) AS n FROM dirty_days")).toEqual({ n: 0 });
  });
});
