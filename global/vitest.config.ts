// The Worker's tests run inside workerd (Miniflare), with the bindings of
// wrangler.jsonc: a local D1 and R2 per test file, migrated by test/setup.ts.
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
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
