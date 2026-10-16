// An upload's records → rounds (CONTRACT §1): each record is a stats CSV row
// keyed by its header, read as csv.go reads it, checked in §1.2's order, and
// re-keyed so the device's hardware tag is never kept.
import { PLAY_SETTINGS, parseTime, playValue } from "../../ui/src/lib/snapshot/engine.js";
import { TSUMS, isMedalTsum } from "./catalog";
import { fromHex, hmacHex, sha256Hex } from "./crypto";
import { DAY, bin, dayStart } from "./days";

/** The stats CSV's fixed columns (csv.go: statsBaseColumns); every other column is a setting. */
const BASE_COLUMNS = new Set([
  "id", "datetime", "script_version", "skill_type", "tsum", "build",
  "duration_seconds", "score", "base_coins", "final_coins", "medals",
]);

/** The boost items in the settings' names, by bit (summary.go: itemBits). */
const ITEM_BITS: [string, number][] = [
  ["bonusCoin", 1], ["bonus5to4", 2], ["bonusTime", 4], ["bonusExp", 8],
  ["bonusScore", 16], ["bonusBubble", 32], ["bonusCombo", 64],
];

/** Why a record was not kept, in the order the checks run. */
export type Reason = "id" | "old" | "future" | "tsum" | "settings" | "field" | "build" | "incomplete" | "duration" | "range" | "repeat" | "pace";

/** Reasons a record may pass later (its round has not happened yet by this clock): the reply asks for it again. */
const RETRY: ReadonlySet<Reason> = new Set(["future"]);

/** A round as the rounds table keeps it, plus what the checks and writes need. */
export interface Round {
  key: string;
  /** The key's last 12 hex: the re-keyed device tag. */
  device: string;
  startMs: number;
  playedAt: number;
  build: number;
  tsum: string;
  /** The bundled catalog has the Tsum: only then do its rounds reach the public figures. */
  known: boolean;
  skill: number;
  /** The script's skill type (`skill_type`), as sent; "" when it sent none. */
  skillType: string;
  items: number;
  /**
   * The play settings (CONTRACT §1.2), from the settings as the engines read
   * them (playValue): chains per board scan and the longest chain, -1 when not
   * recorded, and the bubble strategy, "" when not.
   */
  scan: number;
  chain: number;
  bubble: string;
  version: string;
  /** The settings object as canonical JSON, and its SHA-256. */
  settings: string;
  settingsHash: string;
  duration: number;
  score: number;
  base: number;
  final: number;
  medals: number | null;
  binBase: number;
  binFinal: number;
  binMedals: number | null;
}

export interface Checked {
  /** The kept rounds, in key order. */
  rounds: Round[];
  rejected: Partial<Record<Reason, number>>;
  /** The ids, as sent, of records rejected for a reason that can pass later. */
  retry: string[];
}

// Plausible figures: about twice the largest seen.
const MAX = { score: 200_000_000, base: 50_000, final: 1_500_000, medals: 2_000 };
const PACE_MS = 40_000;
/** Clock skew allowed: how far ahead of now a time, or before its start a round's end, may be. */
const SKEW = 10 * 60;

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * A Tsum id as the catalog writes them. A well-formed one the bundled catalog
 * lacks (a Tsum newer than this deploy) is kept, but left out of the public
 * figures until a deploy knows it.
 */
const TSUM_ID = /^[A-Za-z0-9_.-]{1,48}$/;

/** What one record's settings may hold; past it the record is rejected as `settings`. */
export const SETTINGS_MAX = { columns: 64, name: 64, value: 256, json: 4096 };
/**
 * The longest `script_version` and `skill_type` kept; a longer one, or one
 * with a control character, rejects the record as `field`. Never cut short:
 * a stored field is the field as sent (archive.ts: ROUND_BYTES counts on both).
 */
export const FIELD_MAX = 64;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A play setting of the settings JSON `json` (an SQL expression) as the
 * rounds table keeps it, in SQL: playValue's rule, -1 for a number setting
 * not recorded. Restores and migrations/0003_skill_type.sql make it this way.
 */
export function playSQL(ps: { key: string; number: boolean }, json: string): string {
  const v = `json_extract(${json}, '$.${ps.key}')`, t = `json_type(${json}, '$.${ps.key}')`;
  return ps.number
    ? `(CASE WHEN ${t} IN ('integer', 'real') AND ${v} BETWEEN 0 AND 999 AND ${v} = CAST(${v} AS INTEGER) THEN CAST(${v} AS INTEGER) ELSE -1 END)`
    : `(CASE WHEN ${t} = 'text' AND length(${v}) BETWEEN 1 AND 64 AND ${v} NOT GLOB '*[^A-Za-z0-9_.-]*' THEN ${v} ELSE '' END)`;
}
/** The play settings at their longest in an archive file: two numbers ("999", "-1") and a quoted 64-character id, with their commas. */
export const PLAY_BYTES = 2 * 4 + 64 + 3;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A cell, trimmed as csv.go: cell does. The format sends text; a number is taken as its text. */
const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/** csv.go: floatCell for decimal text. Go's other spellings (Inf, NaN, hex) count as unread. */
function floatCell(s: string): number | null {
  if (!DECIMAL.test(s)) return null;
  const f = Number(s);
  return Number.isFinite(f) ? f : null;
}

/** csv.go: intCell: an integer, or a number truncated toward zero. */
function intCell(s: string): number | null {
  const f = floatCell(s);
  return f === null ? null : Math.trunc(f);
}

/** csv.go: settingValue: switches are T/F, numbers are numbers, the rest stays text. */
function settingValue(s: string): boolean | number | string {
  if (s === "T") return true;
  if (s === "F") return false;
  return floatCell(s) ?? s;
}

/** Keys sorted, so the same settings always hash the same. */
const canonical = (o: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]])));

type Read = Omit<Round, "key" | "device" | "settingsHash"> & { hex: string };

/** UTF-8 bytes of a string, without encoding it when it is plainly short enough. */
const utf8Over = (s: string, max: number) => s.length > max || (s.length * 3 > max && new TextEncoder().encode(s).byteLength > max);

/** One record through the per-record checks, §1.2's first ten. */
function readRecord(rec: Record<string, unknown>, now: number, oldest: number): Read | Reason {
  const id = text(rec.id).toLowerCase();
  if (!UUID7.test(id)) return "id";
  const hex = id.replace(/-/g, "");
  const startMs = parseInt(hex.slice(0, 12), 16);
  const start = startMs / 1000, playedAt = parseTime(text(rec.datetime));
  // A round may end any time after it starts: some Tsums' rounds last hours.
  if (playedAt === null || playedAt < start - SKEW) return "id";
  // Its day is the day it started (§1.1), so the start alone decides whether that day is still open.
  if (start < oldest) return "old";
  if (start > now + SKEW || playedAt > now + SKEW) return "future";
  const tsum = text(rec.tsum);
  if (!TSUM_ID.test(tsum)) return "tsum";

  // Every other column is a setting; an empty cell is left out. Built from
  // entries, so a column called __proto__ is just a setting. Bounded, since
  // each distinct object is a stored row.
  const entries: [string, boolean | number | string][] = [];
  for (const [name, v] of Object.entries(rec)) {
    const s = text(v);
    if (BASE_COLUMNS.has(name) || s === "") continue;
    if (entries.length === SETTINGS_MAX.columns || name.length > SETTINGS_MAX.name || s.length > SETTINGS_MAX.value) return "settings";
    entries.push([name, settingValue(s)]);
  }
  const settings = Object.fromEntries(entries);
  const json = canonical(settings);
  if (utf8Over(json, SETTINGS_MAX.json)) return "settings";
  const version = text(rec.script_version), skillType = text(rec.skill_type);
  if (version.length > FIELD_MAX || skillType.length > FIELD_MAX || CONTROL.test(version) || CONTROL.test(skillType)) return "field";

  let build = text(rec.build);
  if (build !== "global" && build !== "jp") {
    const jp = settings.jpVersion;
    if (typeof jp !== "boolean") return "build";
    build = jp ? "jp" : "global";
  }

  const score = intCell(text(rec.score)), base = intCell(text(rec.base_coins)), final = intCell(text(rec.final_coins));
  const duration = floatCell(text(rec.duration_seconds)), medals = intCell(text(rec.medals));
  if (score === null || base === null || final === null || duration === null || (medals === null && isMedalTsum(tsum))) {
    return "incomplete";
  }
  // No upper limit: some Tsums' rounds last hours.
  if (duration <= 0) return "duration";
  if (score < 0 || score > MAX.score || base < 0 || base > MAX.base || final < 0 || final > MAX.final ||
    (medals !== null && (medals < 0 || medals > MAX.medals))) return "range";

  const skill = settings.skillLevel;
  const [scan, chain, bubble] = PLAY_SETTINGS.map(ps => playValue(settings, ps));
  let items = -1;
  if (Object.hasOwn(settings, "bonusCoin")) {
    items = 0;
    for (const [name, b] of ITEM_BITS) if (settings[name] === true) items |= b;
  }
  return {
    hex, startMs, playedAt, tsum, items,
    known: TSUMS.has(tsum),
    build: build === "jp" ? 1 : 0,
    skill: Number.isInteger(skill) && (skill as number) >= 1 && (skill as number) <= 10 ? (skill as number) : -1,
    skillType,
    scan: scan === "" ? -1 : Number(scan),
    chain: chain === "" ? -1 : Number(chain),
    bubble,
    version,
    settings: json,
    duration, score, base, final, medals,
    binBase: bin(base),
    binFinal: bin(final),
    binMedals: medals !== null && medals > 0 ? bin(medals) : null,
  };
}

/**
 * Reads and checks a batch. nowMs is the server's clock; a round that started
 * more than acceptDays ago, or on or before `archived` (the newest day already
 * in the archive), is old. deviceKey is the HMAC key made from DEVICE_KEY.
 */
export async function checkRecords(
  records: Record<string, unknown>[], nowMs: number, acceptDays: number, deviceKey: CryptoKey, archived = "",
): Promise<Checked> {
  const rejected: Partial<Record<Reason, number>> = {};
  const retry: string[] = [];
  const reject = (r: Reason) => (rejected[r] = (rejected[r] ?? 0) + 1);
  const now = nowMs / 1000;
  const oldest = Math.max(now - acceptDays * DAY, archived ? dayStart(archived) + DAY : 0);

  const read: Read[] = [];
  for (const rec of records) {
    const r = readRecord(rec, now, oldest);
    if (typeof r === "string") {
      reject(r);
      if (RETRY.has(r)) retry.push(text(rec.id));
    } else read.push(r);
  }

  // The key: the id's time and random bits, then the tag's HMAC. A batch holds
  // a few devices and a few settings objects, so each is hashed once.
  const tags = new Map<string, Promise<string>>();
  const hashes = new Map<string, Promise<string>>();
  for (const r of read) {
    const tag = r.hex.slice(20);
    if (!tags.has(tag)) tags.set(tag, hmacHex(deviceKey, fromHex(tag)).then(h => h.slice(0, 12)));
    if (!hashes.has(r.settings)) hashes.set(r.settings, sha256Hex(r.settings));
  }
  const rounds: Round[] = await Promise.all(read.map(async ({ hex, ...r }) => {
    const device = await tags.get(hex.slice(20))!;
    return { ...r, key: hex.slice(0, 20) + device, device, settingsHash: await hashes.get(r.settings)! };
  }));

  // Pace and repeats, per device in start order. A stable sort keeps the
  // first of two same keys first.
  rounds.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const last = new Map<string, Round>();
  const kept: Round[] = [];
  for (const r of rounds) {
    const prev = last.get(r.device);
    if (prev && prev.key === r.key) reject("repeat");
    else if (prev && r.startMs - prev.startMs < PACE_MS) reject("pace");
    else {
      kept.push(r);
      last.set(r.device, r);
    }
  }
  return { rounds: kept, rejected, retry };
}
