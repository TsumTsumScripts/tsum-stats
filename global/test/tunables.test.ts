// The tests' own tunables (tunables.json, bound by vitest.config.ts) reach the
// Worker in place of wrangler.jsonc's vars, so a Paid deployment's numbers
// there move no test.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import FREE from "./tunables.json" with { type: "json" };

/** Every var of Env: a new one fails typecheck until tunables.json has it. */
type Tunables = Omit<Env, "DB" | "BUCKET" | "ASSETS" | "DEVICE_KEY" | "ADMIN_KEY">;
const pinned: Tunables = FREE;

describe("the tests' tunables", () => {
  it("are Free's, whatever wrangler.jsonc sets", () => {
    expect(Object.fromEntries(Object.keys(pinned).map(k => [k, env[k as keyof Tunables]]))).toEqual(pinned);
    // And wrangler.jsonc binds no var they leave out (the secrets are vitest.config.ts's).
    const text = Object.keys(env).filter(k => typeof env[k as keyof typeof env] === "string");
    expect(text.filter(k => !(k in pinned)).sort()).toEqual(["ADMIN_KEY", "DEVICE_KEY"]);
  });
});
