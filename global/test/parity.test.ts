// The global site end to end, against the local server's own answers. Run by
// `go test ./internal/stats` (TestGlobalParity), which writes
// test/.parity/fixture.json: each player's uploads as the forwarder made them,
// and per case the route, the page's parameters and Summarize's answer for
// the same rounds in UTC days. The uploads go through the Worker, its hourly
// job (run by POST /api/v1/admin/rollup) publishes the parts, and the page's
// global engine answers from them, as served at /data/global/. Without the
// fixture there is nothing to run.
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { createGlobalEngine } from "../../ui/src/lib/global/engine.js";
import type { Report } from "../src/job";
import { DAY_MS, admin, call, json } from "./helpers";

interface Totals {
  accepted: number;
  unchanged: number;
  duplicates: number;
  rejected: Record<string, number>;
}

interface Case {
  name: string;
  route: string;
  params: Record<string, string>;
  expected: any;
  /** Summaries: whether the primary stat's and the medal set's spreads can be worked out. */
  spreads?: { primary: boolean; medals: boolean };
}

interface Fixture {
  now: number;
  /** Each player's passes, in order; a pass is its batches. */
  players: { passes: Record<string, unknown>[][]; me: Record<string, unknown> }[];
  /** What the Worker should answer, added up over every player's batches, per pass. */
  uploads: Totals[];
  cases: Case[];
}

const FIXTURE = "./.parity/fixture.json";
const fixtures = import.meta.glob<Fixture>("./.parity/fixture.json", { import: "default" });

/** The page's engine over the files the Worker serves at nowMs. A missing file rejects with its status. */
const engineAt = (nowMs: number) =>
  createGlobalEngine({
    async json(name: string) {
      const res = await call("/data/global/" + name, { now: nowMs });
      if (!res.ok) throw Object.assign(new Error(`${name}: ${res.status}`), { status: res.status });
      return res.json();
    },
  });

// The server leaves some orders open (ties), so those lists are put in a fixed order first (as ui/tests/parity.mjs).
const by = (...keys: string[]) => (a: any, b: any) => {
  for (const k of keys) {
    const d = typeof a[k] === "string" ? a[k].localeCompare(b[k]) : a[k] - b[k];
    if (d) return d;
  }
  return 0;
};
const sortTsums = (t: any[]) => [...t].sort(by("tsum"));

// Sums are added in a different order than SQLite's, so floats may differ in the last places.
function diff(a: any, b: any, path = ""): string[] {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? [] : [`${path}: server ${a}, global ${b}`];
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return a === b ? [] : [`${path}: server ${JSON.stringify(a)}, global ${JSON.stringify(b)}`];
  }
  if (Array.isArray(a) !== Array.isArray(b)) return [`${path}: array vs object`];
  if (Array.isArray(a) && a.length !== b.length) return [`${path}: server has ${a.length} entries, global ${b.length}`];
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diff(a[k], b[k], `${path}.${k}`));
  return out;
}

/** The quartiles and P90: approximate on the global site (CONTRACT §6.2). */
const SPREADS = ["q1Coins", "medianCoins", "q3Coins", "p90Coins"];

/**
 * A spread from the bins: within 2 % of the exact value, exact under 100; null
 * where the bins cannot give one. Checked, then taken out so the rest compares exactly.
 */
function takeSpreads(want: any, got: any, on: boolean, path: string): string[] {
  const out: string[] = [];
  for (const k of SPREADS) {
    const w = want[k], g = got[k];
    const fine = !on || w === null ? g === null : Math.abs(w) < 100 ? g === w : g !== null && Math.abs(g - w) <= 0.02 * Math.abs(w);
    if (!fine) out.push(`${path}.${k}: server ${w}, global ${g}${on ? "" : " (should have none)"}`);
    delete want[k];
    delete got[k];
  }
  return out;
}

function compareSummary(c: Case, want: any, got: any): string[] {
  const out: string[] = [];
  const { primary, medals } = c.spreads!;
  if (got.hours.length) out.push(".hours: the global site has no hours");
  if (got.global?.approx !== true || got.global?.spreads !== primary) out.push(`.global: ${JSON.stringify(got.global)}`);
  // The histogram's buckets come from approximate quartiles, so only its rounds are compared.
  const rounds = (h: any) => h.bins.reduce((n: number, b: any) => n + b.rounds, 0);
  if (primary ? rounds(got.histogram) !== want.totals.coinRounds : got.histogram.bins.length > 0) {
    out.push(`.histogram: ${rounds(got.histogram)} rounds, the server counts ${want.totals.coinRounds}`);
  }
  for (const v of [want, got]) {
    delete v.hours;
    delete v.global;
    delete v.histogram;
    v.tsums = sortTsums(v.tsums);
    v.medals.tsums = sortTsums(v.medals.tsums);
    v.dailyTsums = [...v.dailyTsums].sort(by("day", "tsum"));
    v.mix = [...v.mix].sort(by("build", "tsum", "items"));
  }
  for (const [set, on] of [["", primary], [".medals", medals]] as const) {
    const w = set ? want.medals : want, g = set ? got.medals : got;
    out.push(...takeSpreads(w.totals, g.totals, on, `${set}.totals`));
    if (w.tsums.length !== g.tsums.length) continue; // diff says so
    w.tsums.forEach((t: any, i: number) => out.push(...takeSpreads(t, g.tsums[i], on, `${set}.tsums[${t.tsum}]`)));
  }
  return [...out, ...diff(want, got)];
}

/** Every case through a fresh engine; the names and differences of those that fail. */
async function compare(nowMs: number, cases: Case[]): Promise<string[]> {
  const engine = engineAt(nowMs);
  const failed: string[] = [];
  for (const c of cases) {
    const got = JSON.parse(JSON.stringify(await engine.call(c.route, c.params)));
    const want = structuredClone(c.expected);
    const problems = c.route === "summary" ? compareSummary(c, want, got) : diff(want, c.route === "status" ? pick(got, want) : got);
    if (problems.length) {
      failed.push(`FAIL ${c.name}\n  ${problems.slice(0, 8).join("\n  ")}${problems.length > 8 ? `\n  ...${problems.length - 8} more` : ""}`);
    }
  }
  return failed;
}

const pick = (o: any, like: any) => Object.fromEntries(Object.keys(like).map(k => [k, o[k]]));

/** The hourly job through the admin route, run again while it says more is left; its last report. */
async function rollup(nowMs: number, runs = 50): Promise<Report> {
  for (let i = 1; ; i++) {
    const res = await admin("rollup", {}, nowMs);
    const r = await json<Report & { ok: boolean }>(res);
    expect(res.status, JSON.stringify(r)).toBe(200);
    if (!r.more || i >= runs) return r;
  }
}

describe.skipIf(!fixtures[FIXTURE])("the global site against the server", () => {
  it("answers as Summarize does, live and once archived", { timeout: 600_000 }, async () => {
    const fx = await fixtures[FIXTURE]();
    const now = fx.now;

    // Each player joins, then the passes are uploaded in order, a rollup after each.
    const keys: string[] = [];
    for (let i = 0; i < fx.players.length; i++) {
      const res = await call("/api/v1/join", { body: { client: "tsum-stats/0.25" }, ip: `192.0.2.${i + 1}`, now });
      expect(res.status).toBe(201);
      keys.push((await json<{ key: string }>(res)).key);
    }
    for (let p = 0; p < fx.uploads.length; p++) {
      const sum: Totals = { accepted: 0, unchanged: 0, duplicates: 0, rejected: {} };
      for (let i = 0; i < fx.players.length; i++) {
        for (const batch of fx.players[i].passes[p]) {
          const res = await call("/api/v1/rounds", { body: batch, key: keys[i], now });
          const body = await json<Totals & { ok: boolean }>(res);
          expect(res.status, JSON.stringify(body)).toBe(200);
          sum.accepted += body.accepted;
          sum.unchanged += body.unchanged;
          sum.duplicates += body.duplicates;
          for (const [why, n] of Object.entries(body.rejected)) sum.rejected[why] = (sum.rejected[why] ?? 0) + n;
        }
      }
      expect(sum, `pass ${p + 1}`).toEqual(fx.uploads[p]);
      expect((await rollup(now)).more, "the rollup did not finish").toBe(false);
    }
    for (let i = 0; i < fx.players.length; i++) {
      expect(await json(call("/api/v1/me", { key: keys[i], now })), `player ${i + 1}`).toMatchObject(fx.players[i].me);
    }

    const live = await compare(now, fx.cases);
    expect(live.join("\n"), `${fx.cases.length - live.length}/${fx.cases.length} cases match`).toBe("");

    // A hundred days on, every day is archived and each month compacted into one part.
    const later = now + 100 * DAY_MS;
    expect((await rollup(later, 500)).more, "archiving did not finish").toBe(false);
    const man = await json<{ parts: { file: string }[] }>(call("/data/global/manifest.json", { now: later }));
    expect(man.parts.map(p => p.file.replace(/\.[0-9a-f]{8}\.json$/, ""))).toEqual(["month-2026-08", "month-2026-09", "month-2026-10"]);
    const summaries = fx.cases.filter(c => c.route === "summary");
    const archived = await compare(later, summaries);
    expect(archived.join("\n"), `${summaries.length - archived.length}/${summaries.length} cases match once archived`).toBe("");
  });
});
