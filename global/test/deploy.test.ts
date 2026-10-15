// deploy.sh: the Cloudflare token reaches wrangler and nothing else.
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import script from "../deploy.sh?raw";

/** The script's commands, comments left out. */
const commands = script.split("\n").map(l => l.replace(/^\s*#.*$/, "")).filter(l => l.trim() !== "");

describe("deploy.sh", () => {
  it("passes the Cloudflare token to wrangler alone, never to npm's install scripts or the page's build", () => {
    // Never exported, and one the shell exports is dropped first.
    expect(commands.some(l => /\bexport\b.*CLOUDFLARE_API_TOKEN/.test(l))).toBe(false);
    // Every inherited Cloudflare and wrangler variable is dropped, not just the token.
    const unset = commands.findIndex(l => /CLOUDFLARE_\*.*CF_\*.*WRANGLER_\*.*\bunset\b/.test(l));
    expect(unset).toBeGreaterThanOrEqual(0);
    // The only place it is set is cf's own command line, which runs the lockfile's wrangler.
    const sets = commands.filter(l => /(^|[;{&|]\s*)CLOUDFLARE_API_TOKEN=/.test(l.trim()));
    expect(sets).toEqual([`cf() { CLOUDFLARE_API_TOKEN="$cf_token" ./node_modules/.bin/wrangler "$@"; }`]);
    // Every wrangler command goes through cf; npm and vite never do.
    for (const l of commands) {
      if (/npx wrangler|\.bin\/wrangler/.test(l)) expect(l, l).toMatch(/^cf\(\) \{/);
      if (/\bnpm ci\b|\bvite\b/.test(l)) expect(l, l).not.toMatch(/\bcf\b|CLOUDFLARE_API_TOKEN/);
    }
    for (const sub of ["whoami", "secret list", "d1 migrations apply", "deploy"]) {
      expect(commands.some(l => l.includes(`cf ${sub}`)), sub).toBe(true);
    }
    // The token is read only after anything exported is unset.
    expect(commands.findIndex(l => /cf_token=/.test(l))).toBeGreaterThan(unset);
  });
});
