// The preset gallery (CONTRACT §2.7): submit, the contributor's own, delete, takedown, and the
// job's presets.json.
import { beforeEach, describe, expect, it } from "vitest";
import data from "../../ui/src/lib/presets/shareCodes.json";
import { NOW, admin, call, env, joinNew, json, rollup, wipe } from "./helpers";

beforeEach(wipe);

const CODE = data.cases[3].code; // "enums with ids": a skill and a bubble strategy
const submit = (key: string, body: Record<string, unknown>, now = NOW) => call("/api/v1/presets", { body, key, now });
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
});
