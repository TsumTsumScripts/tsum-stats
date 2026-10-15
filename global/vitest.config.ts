// The Worker's tests run inside workerd (Miniflare), with the bindings of
// wrangler.jsonc: a local D1 and R2 per test file, migrated by test/setup.ts.
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
// Every var, at the Free plans' numbers (D1 Free writes 100k rows a day and
// reads 5M; Workers Free allows 50 queries or R2 operations a run and 10 ms of
// CPU), which the tests are written against. Bound here, over wrangler.jsonc's
// vars, so raising those for a Paid plan moves the deployment and not the
// tests; a test that wants other numbers passes its own env.
import FREE from "./test/tunables.json" with { type: "json" };

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Assigned over wrangler.jsonc's vars name by name, so these win.
          bindings: {
            ...FREE,
            TEST_MIGRATIONS: migrations,
            DEVICE_KEY: "test-device-key",
            ADMIN_KEY: "test-admin-key",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
