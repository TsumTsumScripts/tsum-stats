// The share-code codec (src/lib/presets/shareCode.js) against codes the Tsum script's own settings
// page made (shareCodes.json `cases`, synced by tools/sync-share-codes.js), and the companion links.
//   npm run test:codes
import assert from "node:assert/strict";
import { test } from "node:test";
import data from "../src/lib/presets/shareCodes.json" with { type: "json" };
import { decode, encode, exportText, read } from "../src/lib/presets/shareCode.js";
import { companionLink, packPresets, unpackPresets } from "../src/lib/presets/links.js";

const isDefault = (k, v) => encode({ [k]: v }) === encode({});

for (const c of data.cases) {
  test(`encodes as the page: ${c.name}`, () => assert.equal(encode(c.values), c.code));

  test(`decodes as the page: ${c.name}`, () => {
    const got = decode(c.code);
    assert.equal(got.skipped, 0);
    // Only what differs from the defaults is kept; each kept value is what the page read.
    for (const [k, v] of Object.entries(got.values)) {
      assert.deepEqual(v, c.decoded[k], k);
      assert.ok(!isDefault(k, v), `kept default ${k}`);
    }
    assert.equal(encode(got.values), encode(c.decoded));
  });
}

test("reads the page's own export, names with colons included", () => {
  const got = read(data.exportText).presets;
  assert.deepEqual(got.map((p) => p.name), data.fromText.map((p) => p.name));
  data.fromText.forEach((w, i) => assert.equal(encode(got[i].values), encode(w.values)));
});

test("round-trips an export inside a message", () => {
  const ps = [{ name: "Coins", values: { bonusCoin: true, skillLevel: 3 } }, { name: "Odd: name", values: { skillType: "brand_new" } }];
  const got = read("Here you go!\n" + exportText(ps) + "\nhave fun").presets;
  assert.deepEqual(got.map((p) => [p.name, p.values]), ps.map((p) => [p.name, p.values]));
});

test("reads bare and hard-wrapped codes", () => {
  const code = data.cases[2].code;
  assert.deepEqual(read(`try ${code} !`).presets.map((p) => p.name), [null]);
  assert.equal(read(code.slice(0, 10) + "\n" + code.slice(10)).presets.length, 1);
});

test("refuses damage and other formats; counts fields it can't read", () => {
  const damaged = data.cases[2].code.replace(".C4.", ".C5.");
  assert.deepEqual([read(damaged).presets.length, read(damaged).bad], [0, 1]);
  assert.equal(read("TSUM3-abc.def~").otherFormat, true);
  assert.equal(read("nothing here").otherFormat, false);
  // A skill id this table lacks (a newer script) is skipped, not guessed.
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const skill = data.table.slots.findIndex((s) => s?.key === "skillType");
  const unknown = [...A].find((c) => !Object.values(data.table.slots[skill].ids).includes(c));
  const body = `6.QAQg.${A[skill]}${unknown}`;
  let x = 0;
  for (const ch of body) x = (x * 31 + ch.charCodeAt(0)) % 65521;
  assert.equal(decode(`TSUM4-${A[x % 64]}${body}~`).skipped, 1);
});

test("companion links carry the presets, and nothing else reads as one", () => {
  const ps = [{ name: "Café ☕", values: { maxChain: 7 } }];
  assert.deepEqual(unpackPresets(packPresets(ps)), ps);
  assert.match(companionLink(ps), /^https:\/\/companion\.gapapp\.app\/presets\/import#p=[A-Za-z0-9_-]+$/);
  assert.equal(unpackPresets("not-base64!"), null);
  assert.equal(unpackPresets(btoa(JSON.stringify({ format: "gap-presets", script: "other", presets: [] }))), null);
});
