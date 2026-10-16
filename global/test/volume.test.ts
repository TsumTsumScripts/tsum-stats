// A day at the volume D1 Free must carry: 80,000 rounds from 70 players,
// uploaded the way the forwarder does (each player's pass once an hour, the
// rounds that ended at least 20 minutes before, oldest first, 100 a batch),
// with the hourly job after each hour, while a final day of the same size is
// archived. Everything D1 reads and writes is counted as D1 counts it
// (meta.rows_read, meta.rows_written).
import { describe, expect, it } from "vitest";
import { TSUMS, isMedalTsum } from "../src/catalog";
import { dayStart } from "../src/days";
import { runJob } from "../src/job";
import { batch, call, env, joinNew, one, record, wipe } from "./helpers";
import { counted, random } from "./reference";

const PLAYERS = 70;
const ROUNDS = 80_000;
const DAY = "2026-10-14";
const HOUR = 3600_000;

describe("volume", () => {
  it("reads well under D1 Free's 5M rows a day at 80,000 rounds a day, and counts every row it writes", { timeout: 600_000 }, async () => {
    await wipe();
    const t0 = dayStart(DAY) * 1000;
    const rnd = random(5);
    const coin = [...TSUMS].filter(t => !isMedalTsum(t));
    // Players favour a few Tsums each, as players do.
    const people = [];
    for (let p = 0; p < PLAYERS; p++) people.push({ ...(await joinNew(t0 - 2 * HOUR)), phase: Math.floor(rnd() * 60) * 60_000, sent: 0 });
    const each = Math.ceil(ROUNDS / PLAYERS);
    const step = Math.floor(86400_000 / each);
    const rounds = people.map((_, p) => {
      // A player's Tsums each have their own skill level and play settings; a player keeps to one build and two item sets.
      const favourites = Array.from({ length: 6 }, () => coin[Math.floor(rnd() * 80)]);
      const skills = favourites.map(() => 1 + Math.floor(rnd() * 6));
      const build = rnd() < 0.7 ? "global" : "jp";
      const sets = [["bonusCoin", "bonusTime"], rnd() < 0.5 ? ["bonusCoin"] : []];
      // Each Tsum has its play settings, and one in five rounds tries another.
      const play = favourites.map(() => [[2, 3, 6][Math.floor(rnd() * 3)], [4, 5, 15][Math.floor(rnd() * 3)],
        ["all_mid_chain", "one_mid_chain", "save_one_mid_chain"][Math.floor(rnd() * 3)]] as const);
      const other = [12, 6, "all_asap"] as const;
      const devices = rnd() < 0.3 ? 2 : 1;
      // From an hour before the day, so the first passes bring the day before's last rounds too.
      return Array.from({ length: each }, (_, i) => {
        const at = t0 - HOUR + Math.floor((i + 0.5) * (step - 800)) + 200;
        const base = 1500 + Math.floor(rnd() * 4000);
        const t = Math.floor(rnd() * rnd() * 6);
        const [scan, chain, bubble] = rnd() < 0.2 ? other : play[t];
        return record({
          at, took: 70, duration: 61 + Math.floor(rnd() * 8), tag: `0f${String(p).padStart(6, "0")}${(i % devices).toString().padStart(4, "0")}`,
          tsum: favourites[t], build, skill: skills[t], items: sets[rnd() < 0.7 ? 0 : 1], scan, chain, bubble,
          base, final: Math.floor(base * (1.2 + rnd())), score: Math.floor(rnd() * 20_000_000),
        });
      });
    });

    // The day being archived: 62 days before, the same size, straight into D1.
    const final = "2026-08-13";
    await env.DB.prepare("INSERT OR IGNORE INTO settings (id, hash, json) VALUES (999999, 'old', '{}')").run();
    await env.DB.prepare(`WITH RECURSIVE g(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM g WHERE i < ?1 - 1)
      INSERT INTO rounds (key, contributor, played_at, build, tsum, skill, items, version, settings, duration, score, base, final, medals, bin_base, bin_final, bin_medals)
      SELECT printf('%012x', ?2 + i * ?3) || printf('%08x', i) || printf('%012x', 1000000 + i % ?4), 1 + i % ?4, (?2 + i * ?3) / 1000 + 70,
        i % 2, 'mickey', 1 + i % 6, i % 4, '3.0b4', 999999, 61.5, 1000000 + i, 2000 + i % 3000, 3000 + i % 4000, NULL, 150, 160, NULL FROM g`)
      .bind(ROUNDS, dayStart(final) * 1000, Math.floor(86400_000 / ROUNDS), PLAYERS).run();
    await env.DB.prepare("INSERT INTO state (key, value) VALUES ('archived_through', '2026-08-12')").run();

    // 80,000 rounds a day are more writes than Free's budget allows (each is
    // a row written, and the archive's delete another later): this measures
    // the reads, with room for the writes.
    const k = counted({ ...env, BUDGET_ROWS_PER_DAY: "500000" });
    const jobBy = new Map<string, { n: number; read: number; written: number }>();
    const budgeted = async () => (await one<{ n: number }>("SELECT coalesce(sum(rows), 0) AS n FROM budget")).n;
    const before = await budgeted();
    let ingestRead = 0, ingestWritten = 0, jobRead = 0, jobWritten = 0, accepted = 0, maxQueries = 0, maxR2 = 0, maxBytes = 0;
    for (let h = 0; h < 24; h++) {
      // Each player's pass this hour.
      for (const [p, person] of people.entries()) {
        const at = t0 + h * HOUR + person.phase;
        const ready = rounds[p].filter((r, i) => i >= person.sent && Date.parse(r.datetime.replace(" ", "T") + "Z") <= at - 20 * 60_000);
        for (let i = 0; i < ready.length; i += 100) {
          k.reset();
          const res = await call("/api/v1/rounds", { body: batch(ready.slice(i, i + 100)), key: person.key, env: k.env, now: at });
          expect(res.status).toBe(200);
          accepted += ((await res.json()) as { accepted: number }).accepted;
          ingestRead += k.n.read;
          ingestWritten += k.n.written;
        }
        person.sent += ready.length;
      }
      // The job at :05.
      k.reset();
      const r = await runJob(k.env, t0 + (h + 1) * HOUR + 5 * 60_000);
      expect(r.errors, `run ${h}`).toEqual([]);
      jobRead += k.n.read;
      jobWritten += k.n.written;
      for (const [sql, e] of k.n.bySql) {
        const t = jobBy.get(sql) ?? { n: 0, read: 0, written: 0 };
        t.n += e.n; t.read += e.read; t.written += e.written;
        jobBy.set(sql, t);
      }
      maxQueries = Math.max(maxQueries, k.n.q);
      maxR2 = Math.max(maxR2, k.n.r2);
      maxBytes = Math.max(maxBytes, r.bytes);
    }
    const sentToday = accepted;
    const read = ingestRead + jobRead;
    // The job's heaviest statements, for when this fails.
    const heaviest = [...jobBy].sort((a, b) => b[1].read - a[1].read).slice(0, 6).map(([q, e]) => `${e.n}x read ${e.read} written ${e.written}: ${q}`).join("\n");
    console.log(JSON.stringify({ accepted: sentToday, ingestRead, jobRead, read, perRound: +(read / sentToday).toFixed(2), ingestWritten, jobWritten, maxQueries, maxR2, maxBytes }));
    expect(sentToday).toBeGreaterThan(ROUNDS * 0.95);
    // The final day was archived along the way, from a few scans of it.
    expect((await one<{ value: string }>("SELECT value FROM state WHERE key = 'archived_through'")).value >= final).toBe(true);
    expect(jobBy.get([...jobBy.keys()].find(q => q.startsWith("INSERT INTO archive_parts"))!)!.read).toBeLessThan(3 * ROUNDS);
    // Reads: well under D1 Free's 5,000,000 a day. About 1.37M, 17 a round
    // (ingest 4, the job 13), against an aim of 1.5M: the play settings
    // split a day's cells about 2.2 times (686 to 1,496 here), and the
    // hourly part of the day reads them all.
    expect(read, heaviest).toBeLessThan(1_500_000);
    expect(ingestRead / sentToday).toBeLessThan(4);
    // No run passes Workers Free's 50 queries, and none carries much more
    // than RUN_BYTES (2 MB) from D1 to R2, where its CPU goes, but for a
    // run's first part, which goes whole: the day's, about 3.2 MB here.
    expect(maxQueries).toBeLessThanOrEqual(45);
    expect(maxR2).toBeLessThanOrEqual(40);
    expect(maxBytes).toBeLessThan(3_500_000);
    // Every row written is counted, by day, as D1 counts it.
    expect((await budgeted()) - before).toBe(ingestWritten + jobWritten);
    // And the day's figures are all in: every round sent is in a cell.
    expect((await one<{ n: number }>("SELECT sum(rounds) AS n FROM cells2 WHERE day = ?1", DAY)).n).toBeGreaterThan(ROUNDS * 0.95);
  });
});
