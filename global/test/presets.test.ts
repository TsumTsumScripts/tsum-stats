// The preset gallery (CONTRACT §2.7): submit, the contributor's own, delete, takedown, and the
// job's presets.json.
import { beforeEach, describe, expect, it } from "vitest";
import data from "../../ui/src/lib/presets/shareCodes.json";
import { encode } from "../../ui/src/lib/presets/shareCode.js";
import { NOW, admin, call, env, joinNew, json, one, rollup, wipe } from "./helpers";

beforeEach(wipe);

const CODE = data.cases[3].code; // "enums with ids": a skill and a bubble strategy
const submit = (key: string, body: Record<string, unknown>, now = NOW) => call("/api/v1/presets", { body, key, now });
const A64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** A code with this body and a checksum that matches it. */
const sealed = (body: string) => {
  let x = 0;
  for (const ch of body) x = (x * 31 + ch.charCodeAt(0)) % 65521;
  return `TSUM4-${A64[x % 64]}${body}~`;
};
const published = async () => {
  const obj = await env.BUCKET.get("data/global/presets.json");
  return obj ? ((await obj.json()) as { presets: { id: number; name: string; code: string; skill: string; tsum: string | null }[] }) : null;
};

describe("presets", () => {
  it("takes a contributor's code, names it from the line, and publishes it at the next run", async () => {
    const c = await joinNew();
    const res = await submit(c.key, { code: `Fast  Cabbage :  ${CODE}`, description: " Coins first ", tsum: "" });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: number }>(res);
    expect(await published()).toBeNull();
    await rollup();
    const doc = await published();
    expect(doc!.presets).toEqual([expect.objectContaining({ id, name: "Fast Cabbage", code: CODE, skill: "cabbage_mickey", tsum: null, description: "Coins first" })]);
    // Served from R2 like the manifest.
    const got = await call("/data/global/presets.json");
    expect(got.status).toBe(200);
    expect(await json(got)).toMatchObject({ kind: "tsum-presets", format: 1 });
  });

  it("refuses what it can't read whole", async () => {
    const c = await joinNew();
    const cases: [Record<string, unknown>, number, string][] = [
      [{ code: "not a code" }, 400, "bad-code"],
      [{ code: CODE.replace(".Og.", ".Oz.") }, 400, "bad-code"], // checksum no longer matches
      [{ code: "TSUM3-abc.def~", name: "Old" }, 400, "old-code"],
      [{ code: `${CODE} ${data.cases[2].code}`, name: "Two" }, 400, "bad-code"],
      [{ code: CODE }, 400, "bad-name"],
      [{ code: CODE, name: "A", description: "x".repeat(281) }, 400, "bad-description"],
      [{ code: CODE, name: "A", tsum: "no-such-tsum" }, 400, "bad-tsum"],
    ];
    for (const [body, status, error] of cases) {
      const res = await submit(c.key, body);
      expect([res.status, (await json(res)).error], JSON.stringify(body)).toEqual([status, error]);
    }
    expect((await submit("nope", { code: CODE, name: "A" })).status).toBe(401);
  });

  it("refuses a code naming a skill the synced table lacks (a newer script)", async () => {
    const c = await joinNew();
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const slot = data.table.slots.findIndex(s => s?.key === "skillType");
    const ids = Object.values((data.table.slots[slot] as unknown as { ids: Record<string, string> }).ids);
    const body = `6.QAQg.${A[slot]}${[...A].find(ch => !ids.includes(ch))}`;
    let x = 0;
    for (const ch of body) x = (x * 31 + ch.charCodeAt(0)) % 65521;
    const res = await submit(c.key, { code: `TSUM4-${A[x % 64]}${body}~`, name: "New" });
    expect([res.status, (await json(res)).error]).toEqual([400, "newer-code"]);
  });

  it("lists and deletes only the contributor's own", async () => {
    const a = await joinNew(), b = await joinNew();
    const { id } = await json<{ id: number }>(submit(a.key, { code: CODE, name: "Mine" }));
    expect(await json(call("/api/v1/presets/mine", { key: a.key }))).toMatchObject({ presets: [{ id, name: "Mine", hidden: false }] });
    expect(await json(call("/api/v1/presets/mine", { key: b.key }))).toEqual({ ok: true, presets: [] });
    expect((await call("/api/v1/presets/delete", { body: { id }, key: b.key })).status).toBe(404);
    expect((await call("/api/v1/presets/delete", { body: { id }, key: a.key })).status).toBe(200);
    await rollup();
    expect((await published())!.presets).toEqual([]);
  });

  it("caps a contributor's presets a day", async () => {
    const c = await joinNew();
    for (let i = 0; i < 20; i++) expect((await submit(c.key, { code: CODE, name: `P${i}` })).status).toBe(201);
    const res = await submit(c.key, { code: CODE, name: "One more" });
    expect([res.status, (await json(res)).error]).toEqual([429, "preset-limit"]);
    // The next day has room again.
    expect((await submit(c.key, { code: CODE, name: "Tomorrow" }, NOW + 86400_000)).status).toBe(201);
  });

  it("leaves out taken-down presets and banned contributors'; unlinking deletes them", async () => {
    const a = await joinNew(), b = await joinNew();
    const { id: pa } = await json<{ id: number }>(submit(a.key, { code: CODE, name: "A" }));
    const { id: pb } = await json<{ id: number }>(submit(b.key, { code: CODE, name: "B" }));
    await rollup();
    expect((await published())!.presets.map(p => p.id)).toEqual([pb, pa]);

    expect(await json(admin("takedown", { id: pa }))).toEqual({ ok: true, id: pa, hidden: true });
    await admin("ban", { id: b.id });
    await rollup();
    expect((await published())!.presets).toEqual([]);
    expect(await json(call("/api/v1/presets/mine", { key: a.key }))).toMatchObject({ presets: [{ id: pa, hidden: true }] });

    await admin("takedown", { id: pa, hidden: false });
    await call("/api/v1/me/unlink", { body: {}, key: a.key });
    await rollup();
    expect((await published())!.presets).toEqual([]);
    expect((await admin("takedown", { id: pa })).status).toBe(404);
  });

  it("does not publish again when nothing changed", async () => {
    const c = await joinNew();
    await submit(c.key, { code: CODE, name: "A" });
    await rollup();
    const first = await env.BUCKET.head("data/global/presets.json");
    await rollup(NOW + 3600_000);
    expect((await env.BUCKET.head("data/global/presets.json"))!.uploaded).toEqual(first!.uploaded);
  });

  it("holds the limits for submits sent at once, and deleting gives no room back today", async () => {
    const c = await joinNew();
    const all = await Promise.all(Array.from({ length: 30 }, (_, i) => submit(c.key, { code: CODE, name: `P${i}` })));
    expect(all.filter(r => r.status === 201)).toHaveLength(20);
    expect(all.filter(r => r.status === 429)).toHaveLength(10);
    const { presets } = await json<{ presets: { id: number }[] }>(call("/api/v1/presets/mine", { key: c.key }));
    for (const p of presets) expect((await call("/api/v1/presets/delete", { body: { id: p.id }, key: c.key })).status).toBe(200);
    expect((await submit(c.key, { code: CODE, name: "Again" })).status).toBe(429);
  });

  it("caps a contributor's presets in all", async () => {
    const c = await joinNew();
    for (let d = 0; d < 3; d++) for (let i = 0; i < 20; i++) {
      const res = await submit(c.key, { code: CODE, name: `D${d}P${i}` }, NOW + d * 86400_000);
      expect(res.status).toBe(d * 20 + i < 50 ? 201 : 429);
    }
  });

  it("charges nothing for deleting a preset that isn't the contributor's", async () => {
    const c = await joinNew();
    await rollup();
    const before = await one<{ rows: number }>("SELECT rows FROM budget");
    for (let i = 0; i < 5; i++) expect((await call("/api/v1/presets/delete", { body: { id: 999 }, key: c.key })).status).toBe(404);
    expect(await one<{ rows: number }>("SELECT rows FROM budget")).toEqual(before);
    expect(await env.DB.prepare("SELECT 1 FROM state WHERE key = 'presets_dirty'").first()).toBeNull();
  });

  it("refuses values the script would not apply, and stores codes as this table writes them", async () => {
    const c = await joinNew();
    const refused: [Record<string, unknown>, string][] = [
      [{ maxChain: 99 }, "bad-code"],
      [{ skillLevel: -3 }, "bad-code"],
      [{ skillType: "FREE COINS visit evil.example" }, "newer-code"],
      [{ bubbleStrategy: "constructor" }, "newer-code"],
    ];
    for (const [values, error] of refused) {
      const res = await submit(c.key, { code: encode(values), name: "X" });
      expect([res.status, (await json(res)).error], JSON.stringify(values)).toEqual([400, error]);
    }
    // maxChain 0 is allowed (allowZero); padding and stray separators are dropped on store.
    const zero = encode({ maxChain: 0 });
    const padded = sealed(zero.slice(7, -1).replace(/^(\w+)\.(\w+)/, "$1.$2AAAA") + "....");
    const { id } = await json<{ id: number }>(submit(c.key, { code: padded, name: "Padded" }));
    expect(await one("SELECT code FROM presets WHERE id = ?1", id)).toEqual({ code: zero });
  });

  it("cleans names and descriptions of hidden characters", async () => {
    const c = await joinNew();
    const blank = await submit(c.key, { code: CODE, name: "\u200b\u200b" });
    expect([blank.status, (await json(blank)).error]).toEqual([400, "bad-name"]);
    for (const body of [{ name: "A", description: { x: 1 } }, { name: "A", tsum: 5 }, { name: 7 }]) {
      expect((await submit(c.key, { code: CODE, ...body })).status, JSON.stringify(body)).toBe(400);
    }
    const { id } = await json<{ id: number }>(submit(c.key, {
      code: CODE, name: "Ev\u202eil\u0000 " + "\u{1F600}".repeat(25), description: "a\n\n\n\n\u200bb\u0007",
    }));
    const row = await one<{ name: string; description: string }>("SELECT name, description FROM presets WHERE id = ?1", id);
    expect(row.description).toBe("a\n\nb");
    expect(row.name).toMatch(/^Evil \u{1F600}+$/u);
    expect(row.name.length).toBeLessThanOrEqual(40);
  });

  it("takes only a boolean for takedown's hidden", async () => {
    const c = await joinNew();
    const { id } = await json<{ id: number }>(submit(c.key, { code: CODE, name: "A" }));
    expect((await admin("takedown", { id, hidden: "false" })).status).toBe(400);
    expect((await admin("takedown", { id, hidden: 0 })).status).toBe(400);
  });
});
