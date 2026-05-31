// Palette keys must stay in sync with the CHECK constraint in `0001_init.sql`; hexes are luminance-tuned (~0.25–0.40) for `--fg`.
export const PALETTE = [
  { key: "violet",  group: "cool", hex: "#8e7cf5", label: "Violet" },
  { key: "blue",    group: "cool", hex: "#7d92ff", label: "Blue" },
  { key: "sky",     group: "cool", hex: "#56b5e8", label: "Sky" },
  { key: "seafoam", group: "cool", hex: "#3eb89a", label: "Seafoam" },
  { key: "lime",    group: "warm", hex: "#7ec43a", label: "Lime" },
  { key: "yellow",  group: "warm", hex: "#dba32a", label: "Yellow" },
  { key: "orange",  group: "warm", hex: "#ef8736", label: "Orange" },
  { key: "magenta", group: "warm", hex: "#e25ea0", label: "Magenta" },
];

const BY_KEY = new Map(PALETTE.map((p) => [p.key, p]));

export const DEFAULT_ITEM_COLOR = "blue";

export const DEFAULT_PROJECT_COLOR = "orange";

// Resolve a palette key to its hex; unknown keys fall back to the item default.
export function paletteColor(key) {
  const entry = BY_KEY.get(key);
  if (entry) return entry.hex;
  return BY_KEY.get(DEFAULT_ITEM_COLOR).hex;
}

// Pick a uniformly-random palette key from the group, or null if the group is empty.
export function randomColorKey(group) {
  const candidates = PALETTE.filter((p) => p.group === group);
  if (candidates.length === 0) return null;
  const idx = Math.floor(Math.random() * candidates.length);
  return candidates[idx].key;
}

export function randomItemColor() {
  return randomColorKey("cool");
}

export function randomProjectColor() {
  return randomColorKey("warm");
}
