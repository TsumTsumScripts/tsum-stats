// The Tsums a round may name, from the page's own catalog (ui/public/data),
// so the site and the Worker agree on every id.
import catalog from "../../ui/public/data/catalog.json";

const tsums = catalog.tsums as { id: string; medal?: boolean }[];

export const TSUMS: ReadonlySet<string> = new Set(tsums.map(t => t.id));

/** The Tsums that earn medals rather than coins: a round of one must have read them. */
export const MEDAL_TSUMS: readonly string[] = tsums.filter(t => t.medal).map(t => t.id);
const medalSet = new Set(MEDAL_TSUMS);
export const isMedalTsum = (id: string) => medalSet.has(id);

/**
 * The catalog's ids as one string for SQL's instr(): the public figures leave
 * out a Tsum it lacks. Read when used, so a test can teach it a Tsum.
 */
export const knownList = () => "," + [...TSUMS].join(",") + ",";

/** Names the catalog (FNV-1a over its ids), so what was worked out under another one is made again (parts.ts: PEOPLE). */
export function catalogId(): string {
  let h = 0x811c9dc5;
  for (const ch of knownList()) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(16);
}
