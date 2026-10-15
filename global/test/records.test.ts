// The record checks and derived fields (CONTRACT §1), without D1.
import { describe, expect, it } from "vitest";
import { hmacHex, hmacKey, fromHex, sha256Hex } from "../src/crypto";
import { bin } from "../src/days";
import { SETTINGS_MAX, checkRecords } from "../src/records";
import { DAY_MS, NOW, TAG_A, TAG_B, record, uuid7 } from "./helpers";

const key = () => hmacKey("test-device-key");
const check = async (records: Record<string, unknown>[], now = NOW) => checkRecords(records, now, 60, await key());

describe("rejections", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["id", { ...record(), id: "not-a-uuid" }],
    ["id", { ...record(), id: uuid7(NOW - 3600_000, TAG_A).replace(/-7/, "-4") }],
    ["id", { ...record(), datetime: "yesterday" }],
    // It ends more than the clock skew before it began.
    ["id", record({ took: -11 * 60 })],
    ["old", record({ at: NOW - 61 * DAY_MS })],
    // It ended within 60 days, but began before: its day is the start's.
    ["old", record({ at: NOW - 60 * DAY_MS + 300_000, took: 600 })],
    ["old", record({ at: NOW - 59 * DAY_MS, id: uuid7(NOW - 61 * DAY_MS, TAG_A) })],
    ["future", record({ at: NOW + 11 * 60_000 })],
    ["future", record({ at: NOW + 4 * 3600_000, took: 3 * 3600 })],
    // Only an id no catalog could hold; a well-formed one is kept (below).
    ["tsum", record({ tsum: "no such tsum" })],
    ["tsum", record({ tsum: "" })],
    ["tsum", record({ tsum: "x".repeat(49) })],
    ["tsum", record({ tsum: "../catalog" })],
    ["settings", record({ extra: { ["n".repeat(65)]: "1" } })],
    ["settings", record({ extra: { note: "x".repeat(257) } })],
    ["settings", record({ extra: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`c${i}`, "1"])) })],
    ["settings", record({ extra: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`note${i}`, "é".repeat(120)])) })],
    ["build", record({ build: "" })],
    ["build", record({ build: "kr", extra: { jpVersion: "yes" } })],
    ["incomplete", record({ score: "" })],
    ["incomplete", record({ base: "x" })],
    ["incomplete", record({ final: "" })],
    ["incomplete", record({ duration: "" })],
    ["incomplete", record({ tsum: "mickeyplus" })],
    ["duration", record({ duration: 0 })],
    ["duration", record({ duration: -5 })],
    ["range", record({ score: -1 })],
    ["range", record({ score: 200_000_001 })],
    ["range", record({ base: 50_001 })],
    ["range", record({ final: 1_500_001 })],
    ["range", record({ medals: 2001 })],
    ["range", record({ medals: -1 })],
  ];
  for (const [i, [reason, rec]] of cases.entries()) {
    it(`${reason} (case ${i})`, async () => {
      const out = await check([rec]);
      expect(out.rounds).toEqual([]);
      expect(out.rejected).toEqual({ [reason]: 1 });
    });
  }

  it("takes rounds of any length, and a little clock skew", async () => {
    const out = await check([
      // Three hours, as some Tsums' rounds last; a whole day; a 10-second one.
      record({ at: NOW - 3600_000, took: 3 * 3600 + 20, duration: 3 * 3600 }),
      record({ at: NOW - 10 * 3600_000, took: 26 * 3600, duration: 25 * 3600, tag: TAG_B }),
      record({ at: NOW - 600_000, took: 15, duration: 10, tag: "0c0000000001" }),
      // The end is written by a clock 9 minutes behind the one that made the id.
      record({ at: NOW - 1200_000, took: -9 * 60, tag: "0d0000000001" }),
    ]);
    expect(out.rejected).toEqual({});
    expect(out.rounds.map(r => r.duration).sort((a, b) => a - b)).toEqual([10, 181.5, 3 * 3600, 25 * 3600]);
  });

  it("takes a day already in the archive as old", async () => {
    const out = await checkRecords([record({ at: Date.UTC(2026, 9, 12, 12) }), record({ at: Date.UTC(2026, 9, 13, 0, 5) })],
      NOW, 60, await key(), "2026-10-12");
    expect(out.rejected).toEqual({ old: 1 });
    expect(out.rounds).toHaveLength(1);
  });

  it("checks in the contract's order", async () => {
    // Old and a malformed Tsum: old comes first; a malformed Tsum before
    // too many settings, and those before a missing build.
    const junk = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`c${i}`, "1"]));
    const out = await check([
      record({ at: NOW - 70 * DAY_MS, tsum: "no such" }),
      record({ tsum: "no such", build: "", extra: junk }),
      record({ at: NOW - 600_000, build: "", extra: junk }),
    ]);
    expect(out.rejected).toEqual({ old: 1, tsum: 1, settings: 1 });
  });

  it("keeps a well-formed Tsum the catalog lacks, marked unknown, with its medals unread", async () => {
    const out = await check([record({ tsum: "brandnew_2026.v2", at: NOW - 900_000 }), record({ tsum: "mickey", at: NOW - 600_000 })]);
    expect(out.rejected).toEqual({});
    expect(out.rounds.map(r => [r.tsum, r.known, r.medals])).toEqual([["brandnew_2026.v2", false, null], ["mickey", true, null]]);
  });

  it("takes settings up to their bounds", async () => {
    // record() has eight settings of its own (the skill level and the items); the long name makes 64.
    const most = Object.fromEntries(Array.from({ length: SETTINGS_MAX.columns - 9 }, (_, i) => [`c${String(i).padStart(2, "0")}`, "1"]));
    const out = await check([
      record({ extra: { ...most, ["n".repeat(SETTINGS_MAX.name)]: "x".repeat(SETTINGS_MAX.value) } }),
      // Empty cells are left out, so they do not count.
      record({ at: NOW - 600_000, extra: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`empty${i}`, ""])) }),
    ]);
    expect(out.rejected).toEqual({});
    expect(Object.keys(JSON.parse(out.rounds[0].settings))).toHaveLength(SETTINGS_MAX.columns);
  });

  it("asks again only for a round whose time has not come yet", async () => {
    const soon = record({ at: NOW + 20 * 60_000 });
    const out = await check([soon, record({ at: NOW - 61 * DAY_MS }), record({ tsum: "" }), { ...record(), id: "nope" }]);
    expect(out.rejected).toEqual({ future: 1, old: 1, tsum: 1, id: 1 });
    expect(out.retry).toEqual([soon.id]);
  });

  it("holds a device to 40 s between round starts, and drops a repeated key", async () => {
    const a = record({ at: NOW - 600_000 });
    const tooSoon = record({ at: NOW - 600_000 + 30_000 });
    const later = record({ at: NOW - 600_000 + 40_000 });
    const otherDevice = record({ at: NOW - 600_000 + 5_000, tag: TAG_B });
    const out = await check([later, tooSoon, a, { ...a, score: "1" }, otherDevice]);
    expect(out.rejected).toEqual({ pace: 1, repeat: 1 });
    // The first of the two same ids is kept.
    expect(out.rounds.map(r => r.score)).toEqual([12345678, 12345678, 12345678]);
    expect(out.rounds.map(r => r.playedAt * 1000)).toEqual([NOW - 600_000, NOW - 600_000 + 5_000, NOW - 600_000 + 40_000]);
  });

  it("paces against kept rounds only", async () => {
    const t = NOW - 600_000;
    const out = await check([record({ at: t }), record({ at: t + 30_000 }), record({ at: t + 45_000 })]);
    // The second is too soon after the first; the third is 45 s after the first.
    expect(out.rejected).toEqual({ pace: 1 });
    expect(out.rounds).toHaveLength(2);
  });
});

describe("derived fields", () => {
  it("builds the round as D1 keeps it", async () => {
    const rec = record({ at: NOW - 3600_000, took: 200, base: 3000, final: 4500, items: ["bonusCoin", "bonusTime", "bonusCombo"] });
    const [r] = (await check([rec])).rounds;
    const tagHash = (await hmacHex(await key(), fromHex(TAG_A))).slice(0, 12);
    expect(r.key).toBe(rec.id.replace(/-/g, "").slice(0, 20) + tagHash);
    expect(r.key).toMatch(/^[0-9a-f]{32}$/);
    expect(r.device).toBe(tagHash);
    expect(r.key).not.toContain(TAG_A);
    expect(r).toMatchObject({
      playedAt: (NOW - 3600_000) / 1000, startMs: NOW - 3600_000 - 200_000, build: 0, tsum: "mickey", skill: 5,
      items: 1 | 4 | 64, version: "3.0b4", duration: 181.5, score: 12345678, base: 3000, final: 4500, medals: null,
      binBase: bin(3000), binFinal: bin(4500), binMedals: null,
    });
    expect(r.settings).toBe(JSON.stringify({
      bonus5to4: false, bonusBubble: false, bonusCoin: true, bonusCombo: true, bonusExp: false, bonusScore: false, bonusTime: true, skillLevel: 5,
    }));
    expect(r.settingsHash).toBe(await sha256Hex(r.settings));
  });

  it("falls back to jpVersion for the build", async () => {
    const out = await check([
      record({ build: "", extra: { jpVersion: "T" }, at: NOW - 900_000 }),
      record({ build: "", extra: { jpVersion: "F" }, at: NOW - 600_000 }),
      record({ build: "jp", extra: { jpVersion: "F" }, at: NOW - 300_000 }),
    ]);
    expect(out.rounds.map(r => r.build)).toEqual([1, 0, 1]);
  });

  it("reads the skill level and items, or -1 when unknown", async () => {
    const t = NOW - 3600_000;
    const out = await check([
      record({ at: t, skill: "11" }), record({ at: t + 60_000, skill: "abc" }), record({ at: t + 120_000, skill: "5.5" }),
      record({ at: t + 180_000, skill: "10", items: null }), record({ at: t + 240_000, skill: "1", items: [] }),
      record({ at: t + 300_000, skill: "", items: ["bonusCoin", "bonus5to4", "bonusTime", "bonusExp", "bonusScore", "bonusBubble", "bonusCombo"] }),
    ]);
    expect(out.rounds.map(r => [r.skill, r.items])).toEqual([[-1, 5], [-1, 5], [-1, 5], [10, -1], [1, 0], [-1, 127]]);
  });

  it("reads cells as csv.go does", async () => {
    const [r] = (await check([record({
      score: " 1e3 ", base: "2999.9", final: "+4500", duration: "180", medals: "7.9", tsum: "mickeyplus",
      version: "3.0b4-a-very-long-version-name",
      extra: JSON.parse('{"note": "hello", "empty": "", "ratio": "0.5", "big": "1e400", "flag": "F", "__proto__": "x"}'),
    })])).rounds;
    expect(r).toMatchObject({ score: 1000, base: 2999, final: 4500, duration: 180, medals: 7, binMedals: 7, version: "3.0b4-a-very-lon" });
    const s = JSON.parse(r.settings);
    expect(s).toMatchObject({ note: "hello", ratio: 0.5, big: "1e400", flag: false });
    expect(Object.hasOwn(s, "__proto__")).toBe(true);
    expect("empty" in s).toBe(false);
  });

  it("keeps a non-medal Tsum's unread medals null and bins medals only above 0", async () => {
    const t = NOW - 3600_000;
    const out = await check([
      record({ at: t, tsum: "mickeyplus", medals: 0 }),
      record({ at: t + 60_000, tsum: "mickeyplus", medals: 150 }),
      record({ at: t + 120_000, tsum: "mickey" }),
    ]);
    expect(out.rounds.map(r => [r.medals, r.binMedals])).toEqual([[0, null], [150, bin(150)], [null, null]]);
  });

  it("hashes the same settings the same whatever the column order", async () => {
    const a = record({ at: NOW - 900_000 }), b = record({ at: NOW - 600_000 });
    const reordered = Object.fromEntries(Object.entries(b).reverse());
    const out = await check([a, reordered]);
    expect(out.rounds[0].settingsHash).toBe(out.rounds[1].settingsHash);
  });

  it("bins exactly under 100 and 2 % wide above", () => {
    expect([0, 1, 99, 100, 101, 102, 104].map(bin)).toEqual([0, 1, 99, 100, 100, 101, 101]);
    for (const v of [150, 3000, 4500, 50_000, 1_500_000]) {
      const b = bin(v);
      const low = 100 * 1.02 ** (b - 100);
      expect(low).toBeLessThanOrEqual(v * (1 + 1e-12));
      expect(v).toBeLessThan(low * 1.02);
    }
  });
});
