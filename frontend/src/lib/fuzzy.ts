// Subsequence fuzzy match for short titles: +1 per matched char, +2 for
// adjacency, tiny early-match bonus. Empty query returns items unchanged.

export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return items;
  const scored: { item: T; score: number; idx: number }[] = [];
  items.forEach((item, idx) => {
    const s = score(q, getText(item).toLowerCase());
    if (s != null) scored.push({ item, score: s, idx });
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((x) => x.item);
}

function score(query: string, name: string): number | null {
  let nameIdx = 0;
  let lastMatchIdx = -2;
  let firstMatchIdx = -1;
  let total = 0;
  for (const ch of query) {
    let found = -1;
    for (let ni = nameIdx; ni < name.length; ni++) {
      if (name[ni] === ch) {
        found = ni;
        break;
      }
    }
    if (found === -1) return null;
    if (firstMatchIdx === -1) firstMatchIdx = found;
    total += 1 + (found === lastMatchIdx + 1 ? 2 : 0);
    lastMatchIdx = found;
    nameIdx = found + 1;
  }
  return total - firstMatchIdx * 0.01;
}
