// Presets to and from GAP Companion: a `gap-presets` document (the companion's docs/WORKFLOWS.md,
// "Preset file") carried in a link's fragment, so nothing is fetched and nothing reaches a server.
//
//   Add to GAP Companion:  https://companion.gapapp.app/presets/import#p=<base64url JSON>
//   From GAP Companion:    <this site>/#/presets/convert?p=<base64url JSON>   (`presetShare` in the script)

export const SCRIPT_ID = "app.gap.Tsum";
export const COMPANION_IMPORT = "https://companion.gapapp.app/presets/import";

/** {format, script, presets: [{name, values}]} as base64url of its UTF-8 JSON. */
export function packPresets(presets) {
  const doc = { format: "gap-presets", script: SCRIPT_ID, presets: presets.map((p) => ({ name: p.name, values: p.values })) };
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The presets in a packed document, or null when it isn't one for this script. */
export function unpackPresets(packed) {
  try {
    const bin = atob(packed.replace(/-/g, "+").replace(/_/g, "/"));
    const doc = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    if (doc?.format !== "gap-presets" || doc.script !== SCRIPT_ID || !Array.isArray(doc.presets)) return null;
    return doc.presets
      .filter((p) => p && typeof p.name === "string" && p.values && typeof p.values === "object" && !Array.isArray(p.values))
      .map((p) => ({ name: p.name, values: p.values }));
  } catch {
    return null;
  }
}

/** The link that opens GAP Companion (app or web) on these presets. */
export const companionLink = (presets) => `${COMPANION_IMPORT}#p=${packPresets(presets)}`;
