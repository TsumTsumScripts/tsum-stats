// The Tsums a round may name, from the page's own catalog (ui/public/data),
// so the site and the Worker agree on every id.
import catalog from "../../ui/public/data/catalog.json";

const tsums = catalog.tsums as { id: string; medal?: boolean }[];

export const TSUMS: ReadonlySet<string> = new Set(tsums.map(t => t.id));

/** The Tsums that earn medals rather than coins: a round of one must have read them. */
export const MEDAL_TSUMS: readonly string[] = tsums.filter(t => t.medal).map(t => t.id);
const medalSet = new Set(MEDAL_TSUMS);
export const isMedalTsum = (id: string) => medalSet.has(id);
