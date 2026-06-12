import type { Color } from "@bindings/Color";

// Palette keys mirror the Color binding (and the SQL CHECK); hexes are
// luminance-tuned (~0.25-0.40) to read against --fg in either scheme.
export interface PaletteEntry {
  key: Color;
  group: "cool" | "warm";
  hex: string;
  label: string;
}

export const PALETTE: PaletteEntry[] = [
  { key: "violet", group: "cool", hex: "#8e7cf5", label: "Violet" },
  { key: "blue", group: "cool", hex: "#7d92ff", label: "Blue" },
  { key: "sky", group: "cool", hex: "#56b5e8", label: "Sky" },
  { key: "seafoam", group: "cool", hex: "#3eb89a", label: "Seafoam" },
  { key: "lime", group: "warm", hex: "#7ec43a", label: "Lime" },
  { key: "yellow", group: "warm", hex: "#dba32a", label: "Yellow" },
  { key: "orange", group: "warm", hex: "#ef8736", label: "Orange" },
  { key: "magenta", group: "warm", hex: "#e25ea0", label: "Magenta" },
];

const BY_KEY = new Map<Color, PaletteEntry>(PALETTE.map((p) => [p.key, p]));

const DEFAULT_ITEM_COLOR: Color = "blue";

export function paletteColor(key: Color): string {
  return (BY_KEY.get(key) ?? BY_KEY.get(DEFAULT_ITEM_COLOR)!).hex;
}

// A random cool color, avoiding `exclude` (a neighbour's color) when that still
// leaves a choice; otherwise any cool color.
export function randomItemColor(exclude: readonly Color[] = []): Color {
  return randomOf("cool", exclude);
}

export function randomProjectColor(): Color {
  return randomOf("warm");
}

function randomOf(group: "cool" | "warm", exclude: readonly Color[] = []): Color {
  const candidates = PALETTE.filter((p) => p.group === group);
  const pool = candidates.filter((p) => !exclude.includes(p.key));
  const from = pool.length > 0 ? pool : candidates;
  return from[Math.floor(Math.random() * from.length)]!.key;
}
