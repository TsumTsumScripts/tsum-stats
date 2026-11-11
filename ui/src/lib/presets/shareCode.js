// Tsum share codes (`Name: TSUM4-…~`), read and written as the Tsum script's settings page does
// (../tsum-tsum-script/app.gap.Tsum/src/settings.ts: buildSettingsCode, decodeSettingsCode).
// The table is the script's own, synced by tools/sync-share-codes.js into shareCodes.json;
// never edit either by hand. Used by the page (gallery, convert) and the Worker (submit check).
//
// A preset here is {name, values}: `values` holds only what differs from the defaults, as a
// GAP Companion preset does (a key left out is the default).

import data from "./shareCodes.json" with { type: "json" };

export const TABLE = data.table;
export const SCRIPT_VERSION = data.script;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const RAW = "_"; // an enum value written out in full (no share id)
const SEP = ".";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CHARS = "[A-Za-z0-9._%-]+" + esc(TABLE.suffix);
const CODE = new RegExp(esc(TABLE.prefix) + CHARS, "g");
const LINE = new RegExp("^\\s*([^\\n]+?)\\s*:\\s*(" + esc(TABLE.prefix) + CHARS + ")\\s*$", "gm");
const OTHER = new RegExp(TABLE.otherPrefix + CHARS);
const BY_KEY = new Map(TABLE.slots.filter(Boolean).map((s) => [s.key, s]));

/** The settings a code can carry, in slot order. */
export const slots = () => TABLE.slots.filter(Boolean);

/** One preset's values as a code. A key left out is the default. */
export function encode(values) {
  const bits = [];
  const fields = [];
  TABLE.slots.forEach((s, i) => {
    // Every slot has a bit, so the bitmap's length counts the slots the table knows.
    const v = s ? (s.key in values ? values[s.key] : s.default) : undefined;
    bits.push(s?.kind === "bool" && v === true);
    if (!s || v === undefined || v === null || s.kind === "bool") return;
    let text;
    if (s.kind === "int") {
      if (typeof v !== "number") return;
      const r = Math.round(v);
      if (r === s.default) return;
      text = r.toString(36);
    } else {
      const str = String(v);
      if (str === s.default) return;
      text = s.kind === "enum" ? (s.ids?.[str] ?? RAW + escape(str)) : escape(str);
    }
    fields.push(ALPHABET.charAt(i) + text);
  });
  const body = [TABLE.version.toString(36), pack(bits), ...fields].join(SEP);
  return TABLE.prefix + checksum(body) + body + TABLE.suffix;
}

/**
 * One code's {values, skipped} (values only where they differ from the defaults; skipped: fields
 * this table can't read, e.g. a skill newer than the sync), or null when it isn't a code.
 */
export function decode(code) {
  try {
    const payload = code.substring(TABLE.prefix.length, code.length - TABLE.suffix.length);
    const body = payload.substring(1);
    if (!payload || payload.charAt(0) !== checksum(body)) return null;
    const fields = body.split(SEP);
    if (fields.length < 2 || !/^[0-9a-z]+$/.test(fields[0]) || !/^[A-Za-z0-9_-]+$/.test(fields[1])) return null;
    const values = {};
    const bits = unpack(fields[1]);
    for (let i = 0; i < bits.length && i < TABLE.slots.length; i++) {
      const s = TABLE.slots[i];
      if (s?.kind === "bool") values[s.key] = bits[i];
    }
    let skipped = 0;
    for (const f of fields.slice(2)) {
      if (!f) continue; // a stray separator
      const at = ALPHABET.indexOf(f.charAt(0));
      const s = at >= 0 && at < TABLE.slots.length ? TABLE.slots[at] : null;
      let v;
      try {
        v = s ? value(s, f.substring(1)) : undefined;
      } catch {
        v = undefined; // a malformed escape
      }
      if (!s || v === undefined) skipped++;
      else values[s.key] = v;
    }
    for (const k of Object.keys(values)) if (values[k] === BY_KEY.get(k).default) delete values[k];
    return { values, skipped };
  } catch {
    return null;
  }
}

/**
 * Every preset in pasted text: `Name: code` lines (the script's Export presets), else bare codes
 * (name null; one an editor hard-wrapped is whole again without the line breaks).
 * Returns {presets: [{name, code, values, skipped}], bad, otherFormat}.
 */
export function read(text) {
  const flat = text.replace(/\s+/g, "");
  let found = [...text.matchAll(LINE)].map((m) => [m[1], m[2]]);
  if (!found.length) {
    const bare = [...text.matchAll(CODE)].map((m) => m[0]);
    const one = flat.match(new RegExp(CODE.source));
    found = (bare.length ? bare : one ? [one[0]] : []).map((c) => [null, c]);
  }
  const presets = [];
  for (const [name, code] of found) {
    const d = decode(code);
    if (d) presets.push({ name, code, ...d });
  }
  const o = text.match(OTHER) ?? flat.match(OTHER);
  return { presets, bad: found.length - presets.length, otherFormat: !presets.length && !!o && !o[0].startsWith(TABLE.prefix) };
}

/** What a preset changes, in slot order, as English [label, value] pairs (the script's own words). */
export function describe(values) {
  const out = [];
  for (const s of slots()) {
    if (!(s.key in values) || values[s.key] === s.default) continue;
    const v = values[s.key];
    const text = s.kind === "bool" ? (v ? "On" : "Off")
      : s.kind === "enum" ? (s.options?.[v] ?? String(v))
      : s.kind === "int" && s.scale ? String(v / s.scale) : String(v);
    out.push([s.label ?? s.key, text]);
  }
  return out;
}

/** Presets as `Name: code` lines, what the script's share box takes. */
export const exportText = (presets) => presets.map((p) => `${p.name}: ${encode(p.values)}`).join("\n");

function value(s, text) {
  switch (s.kind) {
    case "int": {
      const n = parseInt(text, 36);
      return isNaN(n) ? undefined : n;
    }
    case "enum":
      if (text.charAt(0) === RAW) return decodeURIComponent(text.substring(1));
      return Object.entries(s.ids ?? {}).find(([, id]) => id === text)?.[0];
    case "string":
      return decodeURIComponent(text);
    default:
      return undefined;
  }
}

function checksum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum = (sum * 31 + body.charCodeAt(i)) % 65521;
  return ALPHABET.charAt(sum % 64);
}

function pack(bits) {
  let packed = "";
  for (let i = 0; i < bits.length; i += 6) {
    let chunk = 0;
    for (let b = 0; b < 6; b++) if (bits[i + b]) chunk |= 1 << b;
    packed += ALPHABET.charAt(chunk);
  }
  return packed;
}

function unpack(packed) {
  const bits = [];
  for (const c of packed) {
    const chunk = ALPHABET.indexOf(c);
    for (let b = 0; b < 6; b++) bits.push(chunk >= 0 && (chunk & (1 << b)) !== 0);
  }
  return bits;
}

// encodeURIComponent, then also . ! ~ * ' ( ): two of them delimit a code.
const escape = (text) => encodeURIComponent(text).replace(/[.!~*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
