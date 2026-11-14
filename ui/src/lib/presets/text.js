// Cleaning a preset's name and description, shared by the Worker (submit) and the page
// (presets GAP Companion sent). Control and format characters (zero-width, direction
// overrides) are dropped, so a name can't look empty, reorder its text or hide a line.

export const NAME_MAX = 40;
export const DESCRIPTION_MAX = 280;

const HIDDEN = /[\p{Cc}\p{Cf}]/gu;

/** Cuts to max UTF-16 units without leaving half of a surrogate pair. */
function cut(text, max) {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** A name as the script keeps one (whitespace collapsed, trimmed, 40 at most), hidden characters dropped. */
export const cleanName = (raw) =>
  cut(String(raw).replace(/\s+/g, " ").replace(HIDDEN, "").replace(/ {2,}/g, " ").trim(), NAME_MAX).trimEnd();

/**
 * A description: line breaks kept (one blank line at most), spaces collapsed, hidden
 * characters dropped. Not cut: a longer one is refused.
 */
export const cleanDescription = (raw) => String(raw)
  .replace(/\r\n?/g, "\n")
  .replace(/[^\S\n]+/g, " ")
  .replace(HIDDEN, (c) => (c === "\n" ? c : ""))
  .replace(/ {2,}/g, " ")
  .split("\n").map((l) => l.trim()).join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
