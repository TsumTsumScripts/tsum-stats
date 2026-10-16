// The admin routes (CONTRACT §2.5).
import { createScheduledController } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { NOW, admin, call, env, joinNew, json, one, rollup, rows, series, upload, wipe } from "./helpers";
import { checkAgainstReference } from "./reference";

beforeEach(wipe);

const POSTS = ["ban", "unban", "merge", "rebuild", "restore", "rollup", "resend"];

describe("admin", () => {
  it("needs the admin key", async () => {
    const c = await joinNew();
    for (const key of [undefined, "nope", c.key]) {
      for (const action of POSTS) {
        const res = await call("/api/v1/admin/" + action, { body: {}, key });
        expect(res.status, `${action} with ${key}`).toBe(401);
      }
      expect((await call("/api/v1/admin/contributors", { key })).status).toBe(401);
    }
    // No ADMIN_KEY set: no key opens it.
    expect((await call("/api/v1/admin/rollup", { body: {}, key: "", env: { ...env, ADMIN_KEY: "" } })).status).toBe(401);
    expect((await call("/api/v1/admin/contributors", { method: "POST", body: {}, key: "test-admin-key" })).status).toBe(405);
    expect((await call("/api/v1/admin/nope", { body: {}, key: "test-admin-key" })).status).toBe(404);
  });

  it("lists every contributor", async () => {
    const a = await joinNew(), b = await joinNew(NOW + 1000);
    await upload(a.key, [...series(3, { tag: "0a0000000001" }), ...series(2, { tag: "0a0000000002", end: NOW - 1800_000 })]);
    await upload(b.key, series(3, { tag: "0a0000000001" }));
    await admin("ban", { id: b.id });
    expect(await json(call("/api/v1/admin/contributors", { key: "test-admin-key" }))).toEqual({
      ok: true,
      contributors: [
        { id: a.id, status: "active", createdAt: "2026-10-14T18:00:00Z", lastSeen: "2026-10-14T18:00:00Z", client: "tsum-stats/test", rounds: 5, duplicates: 0, devices: 2 },
        { id: b.id, status: "banned", createdAt: "2026-10-14T18:00:01Z", lastSeen: "2026-10-14T18:00:00Z", client: "tsum-stats/test", rounds: 3, duplicates: 0, devices: 1 },
      ],
    });
  });

  it("calls for a full re-upload: every reply after it carries the new number", async () => {
    const c = await joinNew();
    const rounds = series(2);
    const before = await upload(c.key, rounds);
    expect(before.body).toMatchObject({ resend: 0 });
    expect(await json(admin("resend", {}))).toEqual({ ok: true, resend: 1 });
    expect(await json(admin("resend", {}))).toEqual({ ok: true, resend: 2 });
    // The same rounds again: nothing written, and the reply says 2.
    const again = await upload(c.key, rounds);
    expect(again.body).toMatchObject({ accepted: 0, unchanged: 2, resend: 2 });
    expect(await json(call("/api/v1/me", { key: c.key }))).toMatchObject({ resend: 2 });
  });

  it("refuses bad ids and contributors being unlinked", async () => {
    const c = await joinNew();
    expect((await admin("ban", { id: 999 })).status).toBe(404);
    expect((await admin("ban", { id: "1" })).status).toBe(400);
    expect((await admin("ban", {})).status).toBe(400);
    expect((await admin("merge", { from: c.id, into: c.id })).status).toBe(400);
    expect((await admin("merge", { from: c.id, into: 999 })).status).toBe(404);
    expect((await admin("merge", { from: 0, into: c.id })).status).toBe(400);
    await call("/api/v1/me/unlink", { method: "POST", key: c.key });
    expect((await admin("ban", { id: c.id })).status).toBe(400);
  });

  it("merges one contributor into another", async () => {
    const a = await joinNew(), b = await joinNew();
    // b is a's second install: the same device, and one of its own.
    const shared = series(6, { tag: "0a0000000001" });
    await upload(a.key, shared.slice(0, 4));
    await upload(b.key, [...shared, ...series(3, { tag: "0b0000000001", end: NOW - 1800_000 })]);
    await rollup();
    const res = await admin("merge", { from: b.id, into: a.id });
    expect(await res.json()).toEqual({ ok: true, from: b.id, into: a.id });
    expect(await rows("SELECT contributor, count(*) AS n FROM rounds GROUP BY contributor")).toEqual([{ contributor: a.id, n: 9 }]);
    expect(await rows("SELECT contributor, rounds FROM devices ORDER BY rounds")).toEqual([
      { contributor: a.id, rounds: 3 }, { contributor: a.id, rounds: 6 },
    ]);
    expect(await one("SELECT rounds_total, dup_rounds, day_rounds FROM contributors WHERE id = ?1", a.id))
      .toEqual({ rounds_total: 9, dup_rounds: 4, day_rounds: 9 });
    expect(await one("SELECT count(*) AS n FROM contributors WHERE id = ?1", b.id)).toEqual({ n: 0 });
    expect(await one("SELECT value FROM state WHERE key = 'merged:' || ?1", String(b.id))).toEqual({ value: String(a.id) });
    expect((await call("/api/v1/me", { key: b.key })).status).toBe(401);
    expect(await one("SELECT count(*) AS n FROM contrib_cells WHERE contributor = ?1", b.id)).toEqual({ n: 0 });
    expect(await one("SELECT count(*) AS n FROM dirty_days")).toEqual({ n: 1 });
    await rollup();
    await checkAgainstReference(new Set());
    expect(await one("SELECT sum(devices) AS d FROM contrib_cells WHERE contributor = ?1", a.id)).toEqual({ d: 2 });
    expect(await json(call("/api/v1/me", { key: a.key }))).toMatchObject({ rounds: 9, duplicates: 4, devices: 2, first: "2026-10-14" });
  });

  it("refuses a merge that today's write budget has no room for", async () => {
    const a = await joinNew(), b = await joinNew();
    await upload(a.key, series(40, { tag: "0a0000000001" }));
    await upload(b.key, series(2, { tag: "0b0000000001" }));
    await rollup();
    const spent = (await one<{ rows: number }>("SELECT rows FROM budget")).rows;
    const res = await call("/api/v1/admin/merge", { body: { from: a.id, into: b.id }, key: "test-admin-key", env: { ...env, BUDGET_ROWS_PER_DAY: String(spent + 20) } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "budget" });
    expect(await one("SELECT count(*) AS n FROM rounds WHERE contributor = ?1", a.id)).toEqual({ n: 40 });
    // A ban writes a few rows and always goes through, its rows counted.
    const banned = await call("/api/v1/admin/ban", { body: { id: a.id }, key: "test-admin-key", env: { ...env, BUDGET_ROWS_PER_DAY: String(spent) } });
    expect(banned.status).toBe(200);
    await admin("unban", { id: a.id });
    expect((await one<{ rows: number }>("SELECT rows FROM budget")).rows).toBeGreaterThan(spent);
    // With room, it moves every round, found by day rather than by reading the whole table.
    expect((await admin("merge", { from: a.id, into: b.id })).status).toBe(200);
    expect(await rows("SELECT contributor, count(*) AS n FROM rounds GROUP BY contributor")).toEqual([{ contributor: b.id, n: 42 }]);
  });

  it("marks days dirty for a rebuild", async () => {
    const c = await joinNew();
    await upload(c.key, [...series(2, { end: NOW - 3 * 86400_000 }), ...series(2)]);
    await rollup();
    expect(await json(admin("rebuild", {}))).toEqual({ ok: true, from: "2026-10-11", to: "2026-10-14", days: 4 });
    expect((await rows("SELECT day FROM dirty_days ORDER BY day")).map(r => r.day)).toEqual(["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(await json(admin("rebuild", { from: "2026-09-01", to: "2026-09-03" }))).toMatchObject({ days: 3 });
    expect((await admin("rebuild", { from: "2026-09-31" })).status).toBe(400);
    expect((await admin("rebuild", { from: "2024-01-01", to: "2026-01-01" })).status).toBe(400);
    // Days with nothing in D1 and nothing published are no work.
    const reports = await rollup();
    expect(reports.flatMap(r => r.rendered)).toEqual([]);
    await wipe();
    expect(await json(admin("rebuild", {}))).toEqual({ ok: true, days: 0 });
  });

  it("runs the hourly job on request, and on the cron", async () => {
    const c = await joinNew();
    await upload(c.key, series(2));
    expect(await json(admin("rollup"))).toMatchObject({ ok: true, folded: 2, recomputed: [], manifest: true, more: false, errors: [] });
    await upload(c.key, series(1, { end: NOW - 600_000 }));
    await worker.scheduled(createScheduledController({ scheduledTime: NOW, cron: "5 * * * *" }), env);
    expect(await one("SELECT sum(rounds) AS n FROM cells2")).toEqual({ n: 3 });
  });

  it("refuses to work without DEVICE_KEY", async () => {
    const res = await call("/api/v1/join", { body: {}, env: { ...env, DEVICE_KEY: "" } });
    expect(res.status).toBe(500);
    await expect(worker.scheduled(createScheduledController(), { ...env, DEVICE_KEY: "" })).rejects.toThrow();
  });
});
