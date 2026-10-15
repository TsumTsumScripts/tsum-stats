// Days, keys and bins. A day is a UTC calendar day "YYYY-MM-DD"; times are
// epoch seconds unless they say ms.
import { sqlTime } from "../../ui/src/lib/snapshot/engine.js";

export const DAY = 86400;

/** The UTC day of an epoch second. */
export const dayOf = (sec: number): string => sqlTime(sec).slice(0, 10);

/** 00:00 UTC of a day, in epoch seconds. */
export const dayStart = (day: string): number =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 1000;

export const addDays = (day: string, n: number): string => dayOf(dayStart(day) + n * DAY);

/** A real calendar day written "YYYY-MM-DD". */
export const isDay = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && dayOf(dayStart(s)) === s;

/** "YYYY-MM" → the first day of the next month. */
export function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** Milliseconds as the 12 hex digits a UUIDv7 starts with. */
export const hex48 = (ms: number): string => Math.max(0, Math.floor(ms)).toString(16).padStart(12, "0");

/** When a round started, in epoch seconds: its key's first 12 hex digits are the start in ms. */
export const keyStart = (key: string): number => Math.floor(parseInt(key.slice(0, 12), 16) / 1000);

/** A round's day: the UTC day it started (CONTRACT §1.1), however long it lasted. */
export const keyDay = (key: string): string => dayOf(keyStart(key));

/** A day as SQL bounds: the key range of the rounds that started on it. */
export interface DayRange {
  lo: string;
  hi: string;
}

export function dayRange(day: string): DayRange {
  const from = dayStart(day);
  return { lo: hex48(from * 1000) + "0".repeat(20), hi: hex48((from + DAY) * 1000) + "0".repeat(20) };
}

/** The WHERE clause for one day's rounds, with dayRange's values bound at ?1 and ?2. */
export const DAY_ROUNDS = "key >= ?1 AND key < ?2";
export const dayParams = (r: DayRange) => [r.lo, r.hi];

/**
 * A figure's histogram bin (CONTRACT §5): exact under 100, then 2 % wide. The
 * page only ever reads bins back (low/mid), so this is the one place they are
 * made; restore's SQL copy (archive.ts: binSQL) must agree.
 */
export const bin = (v: number): number => (v < 100 ? v : 100 + Math.floor(Math.log(v / 100) / Math.log(1.02)));
