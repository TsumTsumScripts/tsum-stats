// POST /api/v1/rounds (CONTRACT §2.2), join, me and the bearer check.
import { beforeEach, describe, expect, it } from "vitest";
import { fromHex, hmacHex, hmacKey } from "../src/crypto";
import { bin } from "../src/days";
import {
  NOW, TAG_A, TAG_B, admin, batch, call, env, joinNew, json, one, record, rollup, rows, series, upload, wipe,
} from "./helpers";

beforeEach(wipe);

const TABLES = ["contributors", "devices", "settings", "rounds", "dirty_days", "budget", "join_limits", "state", "cells", "bins", "contrib_cells"];

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("bad requests", () => {
  it("needs a known key", async () => {
    expect((await call("/api/v1/rounds", { body: batch([record()]) })).status).toBe(401);
    const res = await call("/api/v1/rounds", { body: batch([record()]), key: "nope" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    expect((await call("/api/v1/me", { key: "nope" })).status).toBe(401);
  });

  it("refuses what is not a batch", async () => {
    const c = await joinNew();
    const bad = [
      "{", JSON.stringify([]), JSON.stringify({ ...batch([record()]), schema: "gap.round-stats/2" }),
      JSON.stringify(batch([])), JSON.stringify(batch(Array.from({ length: 251 }, () => record()))),
      JSON.stringify(batch([record(), "row"])), JSON.stringify(batch([[1]])), JSON.stringify({ schema: "gap.round-stats/1" }),
    ];
    for (const raw of bad) {
      const res = await call("/api/v1/rounds", { raw, key: c.key, headers: { "content-type": "application/json" } });
      expect(res.status, raw.slice(0, 40)).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "bad-request" });
    }
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 0 });
  });

  it("answers unknown routes and wrong methods", async () => {
    expect(await json(call("/api/v1/nope"))).toEqual({ ok: false, error: "not-found" });
    const res = await call("/api/v1/rounds", { method: "GET" });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ ok: false, error: "method" });
    expect((await call("/api/v1/join", { method: "PUT" })).status).toBe(405);
    expect((await call("/api/v1/me", { method: "POST", body: {} })).status).toBe(405);
  });

  it("takes gzipped bodies, up to 1 MiB inflated", async () => {
    const c = await joinNew();
    const raw = await gzip(JSON.stringify(batch(series(3))));
    const res = await call("/api/v1/rounds", { raw, key: c.key, headers: { "content-encoding": "gzip", "content-type": "application/json" } });
    expect(await res.json()).toMatchObject({ ok: true, accepted: 3 });

    const big = JSON.stringify({ ...batch([record()]), pad: "x".repeat(1 << 20) });
    const tooBig = await call("/api/v1/rounds", { raw: await gzip(big), key: c.key, headers: { "content-encoding": "gzip" } });
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({ ok: false, error: "too-large" });
    expect((await call("/api/v1/rounds", { raw: big, key: c.key })).status).toBe(413);

    const junk = await call("/api/v1/rounds", { raw: "not gzip", key: c.key, headers: { "content-encoding": "gzip" } });
    expect(junk.status).toBe(400);
  });
});

describe("what is stored", () => {
  it("keeps each accepted round with its derived fields, keyed without the device tag", async () => {
    const c = await joinNew();
    const recs = [
      record({ at: NOW - 7200_000, tsum: "mickeyplus", medals: 150, skill: 6, items: ["bonusCoin", "bonusScore"], build: "jp" }),
      record({ at: NOW - 3600_000, tsum: "mickey", items: null, skill: 12, tag: TAG_B }),
      record({ at: NOW - 1800_000, tsum: "nosuch" }),
    ];
    const up = await upload(c.key, recs);
    expect(up.body).toEqual({ ok: true, accepted: 2, unchanged: 0, duplicates: 0, rejected: { tsum: 1 } });

    const tagKey = await hmacKey("test-device-key");
    const hashOf = async (tag: string) => (await hmacHex(tagKey, fromHex(tag))).slice(0, 12);
    const got = await rows("SELECT * FROM rounds ORDER BY key");
    expect(got).toEqual([
      {
        key: recs[0].id.replace(/-/g, "").slice(0, 20) + (await hashOf(TAG_A)), contributor: c.id, played_at: (NOW - 7200_000) / 1000,
        build: 1, tsum: "mickeyplus", skill: 6, items: 17, version: "3.0b4", settings: expect.any(Number), duration: 181.5,
        score: 12345678, base: 3000, final: 4500, medals: 150, bin_base: bin(3000), bin_final: bin(4500), bin_medals: bin(150),
      },
      {
        key: recs[1].id.replace(/-/g, "").slice(0, 20) + (await hashOf(TAG_B)), contributor: c.id, played_at: (NOW - 3600_000) / 1000,
        build: 0, tsum: "mickey", skill: -1, items: -1, version: "3.0b4", settings: expect.any(Number), duration: 181.5,
        score: 12345678, base: 3000, final: 4500, medals: null, bin_base: bin(3000), bin_final: bin(4500), bin_medals: null,
      },
    ].sort((a, b) => (a.key < b.key ? -1 : 1)));
    expect(await rows("SELECT day FROM dirty_days")).toEqual([{ day: "2026-10-14" }]);
    expect(await rows("SELECT rows FROM budget")).toEqual([{ rows: 2 }]);
    expect(await rows("SELECT device_hash, contributor, first_seen, last_seen, rounds FROM devices ORDER BY device_hash")).toEqual([
      { device_hash: await hashOf(TAG_A), contributor: c.id, first_seen: (NOW - 7200_000) / 1000, last_seen: (NOW - 7200_000) / 1000, rounds: 1 },
      { device_hash: await hashOf(TAG_B), contributor: c.id, first_seen: (NOW - 3600_000) / 1000, last_seen: (NOW - 3600_000) / 1000, rounds: 1 },
    ].sort((a, b) => (a.device_hash < b.device_hash ? -1 : 1)));
    expect(await one("SELECT rounds_total, dup_rounds, day, day_rounds, last_seen FROM contributors WHERE id = ?1", c.id))
      .toEqual({ rounds_total: 2, dup_rounds: 0, day: "2026-10-14", day_rounds: 2, last_seen: NOW / 1000 });

    // The hardware tag is nowhere in D1, after a rollup too.
    await rollup();
    for (const t of TABLES) {
      const dump = JSON.stringify(await rows(`SELECT * FROM ${t}`));
      for (const tag of [TAG_A, TAG_B]) expect(dump, t).not.toContain(tag);
    }
  });

  it("stores each settings object once, by its canonical hash", async () => {
    const c = await joinNew();
    const a = series(4, { skill: 5 });
    const b = series(2, { skill: 7, end: NOW - 1800_000 });
    // Same settings in another column order.
    a[1] = Object.fromEntries(Object.entries(a[1]).reverse());
    expect((await upload(c.key, [...a, ...b])).body.accepted).toBe(6);
    const settings = await rows<{ hash: string; json: string }>("SELECT hash, json FROM settings ORDER BY json");
    expect(settings.map(s => JSON.parse(s.json).skillLevel)).toEqual([5, 7]);
    expect(await one("SELECT count(DISTINCT settings) AS n FROM rounds")).toEqual({ n: 2 });
    // A second contributor with the same settings adds no row.
    const d = await joinNew();
    await upload(d.key, series(2, { skill: 5, tag: TAG_B }));
    expect(await one("SELECT count(*) AS n FROM settings")).toEqual({ n: 2 });
  });
});

describe("duplicates", () => {
  it("writes nothing for an unchanged re-send and updates a changed one", async () => {
    const c = await joinNew();
    const recs = series(10);
    await upload(c.key, recs);
    const again = await upload(c.key, recs);
    expect(again.body).toEqual({ ok: true, accepted: 0, unchanged: 10, duplicates: 0, rejected: {} });
    expect(await one("SELECT rows FROM budget")).toEqual({ rows: 10 });
    expect(await one("SELECT rounds_total, day_rounds FROM contributors WHERE id = ?1", c.id)).toEqual({ rounds_total: 10, day_rounds: 10 });
    // A round that began just before midnight and ended after it, then sent
    // again as ending before it: its day is the start's either way.
    const moved = record({ at: Date.UTC(2026, 9, 14, 0, 2, 0) });
    await upload(c.key, [moved]);
    await env.DB.prepare("DELETE FROM dirty_days").run();
    const changed = { ...recs[2], final_coins: "5000" };
    const movedBack = { ...moved, datetime: "2026-10-13 23:59:30" };
    const res = await upload(c.key, [changed, movedBack, recs[5]]);
    expect(res.body).toEqual({ ok: true, accepted: 2, unchanged: 1, duplicates: 0, rejected: {} });
    expect(await one("SELECT final FROM rounds WHERE played_at = ?1", Date.parse(recs[2].datetime.replace(" ", "T") + "Z") / 1000))
      .toEqual({ final: 5000 });
    // The changed rounds' start days are recomputed.
    expect((await rows("SELECT day FROM dirty_days ORDER BY day")).map(r => r.day)).toEqual(["2026-10-13", "2026-10-14"]);
    expect(await one("SELECT rows FROM budget")).toEqual({ rows: 13 });
    // An update is not a new round, but it counts towards the quota.
    expect(await one("SELECT rounds_total, day_rounds FROM contributors WHERE id = ?1", c.id)).toEqual({ rounds_total: 11, day_rounds: 13 });
  });

  it("keeps the first sender's round and counts the rest as duplicates", async () => {
    const a = await joinNew(), b = await joinNew();
    const recs = series(5);
    await upload(a.key, recs);
    const changed = recs.map(r => ({ ...r, score: "1" }));
    const res = await upload(b.key, [...changed, record({ tag: TAG_B })]);
    expect(res.body).toEqual({ ok: true, accepted: 1, unchanged: 0, duplicates: 5, rejected: {} });
    expect(await rows("SELECT contributor, count(*) AS n, min(score) AS s FROM rounds GROUP BY contributor ORDER BY contributor"))
      .toEqual([{ contributor: a.id, n: 5, s: 12345678 }, { contributor: b.id, n: 1, s: 12345678 }]);
    expect(await one("SELECT dup_rounds, rounds_total FROM contributors WHERE id = ?1", b.id)).toEqual({ dup_rounds: 5, rounds_total: 1 });
    // b's view of a's device is recorded, with no rounds of its own on it.
    expect(await rows("SELECT contributor, rounds FROM devices ORDER BY contributor, rounds")).toEqual([
      { contributor: a.id, rounds: 5 }, { contributor: b.id, rounds: 0 }, { contributor: b.id, rounds: 1 },
    ]);
    const me = await json(call("/api/v1/me", { key: b.key }));
    expect(me).toMatchObject({ rounds: 1, duplicates: 5, devices: 2 });
  });
});

describe("limits", () => {
  it("refuses a batch past the contributor's quota, storing nothing", async () => {
    const small = { ...env, QUOTA_PER_CONTRIBUTOR: "12" };
    const c = await joinNew();
    const ten = series(10);
    const first = await call("/api/v1/rounds", { body: batch(ten), key: c.key, env: small });
    expect(first.status).toBe(200);
    const res = await call("/api/v1/rounds", { body: batch(series(3, { end: NOW - 600_000 })), key: c.key, env: small });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "quota" });
    // 18:00 UTC: six hours to midnight.
    expect(res.headers.get("retry-after")).toBe(String(6 * 3600));
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 10 });
    expect(await one("SELECT rows FROM budget")).toEqual({ rows: 10 });
    expect(await one("SELECT day_rounds, last_seen FROM contributors WHERE id = ?1", c.id)).toEqual({ day_rounds: 10, last_seen: NOW / 1000 });
    // Unchanged rows still pass, and the next day starts afresh.
    expect((await call("/api/v1/rounds", { body: batch(ten), key: c.key, env: small })).status).toBe(200);
    const tomorrow = NOW + 7 * 3600_000;
    const next = await call("/api/v1/rounds", { body: batch(series(3, { end: NOW - 600_000 })), key: c.key, env: small, now: tomorrow });
    expect(await next.json()).toMatchObject({ ok: true, accepted: 3 });
  });

  it("refuses a batch past the day's write budget, storing nothing", async () => {
    const small = { ...env, BUDGET_ROWS_PER_DAY: "12" };
    const a = await joinNew(), b = await joinNew();
    await call("/api/v1/rounds", { body: batch(series(10)), key: a.key, env: small });
    const res = await call("/api/v1/rounds", { body: batch(series(3, { tag: TAG_B })), key: b.key, env: small, now: NOW + 1000 });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "budget" });
    expect(res.headers.get("retry-after")).toBe(String(6 * 3600 - 1));
    expect(await one("SELECT count(*) AS n FROM rounds")).toEqual({ n: 10 });
    expect(await one("SELECT count(*) AS n FROM devices")).toEqual({ n: 1 });
    expect(await one("SELECT day_rounds FROM contributors WHERE id = ?1", b.id)).toEqual({ day_rounds: 0 });
  });
});

describe("contributors", () => {
  it("joins with a one-time key, at most five times a day from an address", async () => {
    const ip = "192.0.2.7";
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await call("/api/v1/join", { body: i ? { client: "tsum-stats/0.25" } : {}, ip });
      expect(res.status).toBe(201);
      const body = await json<{ ok: boolean; id: number; key: string }>(res);
      expect(body.ok).toBe(true);
      expect(body.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      ids.push(body.id);
    }
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    const sixth = await call("/api/v1/join", { body: {}, ip });
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ ok: false, error: "join-limit" });
    expect(sixth.headers.get("retry-after")).toBe(String(6 * 3600));
    // Another address, or the next day, is fine.
    expect((await call("/api/v1/join", { body: {}, ip: "192.0.2.8" })).status).toBe(201);
    expect((await call("/api/v1/join", { body: {}, ip, now: NOW + 7 * 3600_000 })).status).toBe(201);
    // The address is kept only as an HMAC; keys only as hashes.
    const dump = JSON.stringify(await rows("SELECT * FROM join_limits")) + JSON.stringify(await rows("SELECT * FROM contributors"));
    expect(dump).not.toContain(ip);
    expect(await one("SELECT client FROM contributors WHERE id = 2")).toEqual({ client: "tsum-stats/0.25" });
    expect((await call("/api/v1/join", { raw: "[1]", ip: "192.0.2.9" })).status).toBe(400);
  });

  it("never hands out an id twice", async () => {
    const a = await joinNew();
    await env.DB.prepare("DELETE FROM contributors WHERE id = ?1").bind(a.id).run();
    expect((await joinNew()).id).toBe(a.id + 1);
  });

  it("shows a contributor its own record", async () => {
    const c = await joinNew(NOW - 86400_000 * 3);
    await upload(c.key, series(4, { end: NOW - 86400_000 * 2 }), NOW - 86400_000 * 2);
    await upload(c.key, series(3), NOW);
    expect(await json(call("/api/v1/me", { key: c.key }))).toEqual({
      ok: true, id: c.id, status: "active", since: "2026-10-11", lastSeen: "2026-10-14T18:00:00Z", rounds: 7, duplicates: 0,
      devices: 1, first: null, last: null, today: { rounds: 3, quota: 5000 },
    });
    await rollup();
    await admin("ban", { id: c.id });
    expect(await json(call("/api/v1/me", { key: c.key, now: NOW + 86400_000 }))).toMatchObject({
      status: "active", first: "2026-10-12", last: "2026-10-14", today: { rounds: 0, quota: 5000 },
    });
  });
});
