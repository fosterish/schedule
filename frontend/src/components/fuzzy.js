// Subsequence fuzzy match for short titles: +1 per matched char, +2 for adjacency, tiny early-match bonus.

function score(query, name) {
  let nameIdx = 0;
  let lastMatchIdx = -2;
  let firstMatchIdx = -1;
  let total = 0;
  for (let qi = 0; qi < query.length; qi++) {
    const ch = query[qi];
    let found = -1;
    for (let ni = nameIdx; ni < name.length; ni++) {
      if (name[ni] === ch) {
        found = ni;
        break;
      }
    }
    if (found === -1) return null;
    if (firstMatchIdx === -1) firstMatchIdx = found;
    const consecutive = found === lastMatchIdx + 1;
    total += 1 + (consecutive ? 2 : 0);
    lastMatchIdx = found;
    nameIdx = found + 1;
  }
  return total - firstMatchIdx * 0.01;
}

/** Return items matching query, ranked by score descending; ties keep original order. Empty query returns items unchanged. */
export function fuzzyFilter(items, query, getText) {
  const q = (query || "").trim().toLowerCase();
  if (q === "") return items;
  const scored = [];
  for (let i = 0; i < items.length; i++) {
    const text = String(getText(items[i]) || "").toLowerCase();
    const s = score(q, text);
    if (s != null) scored.push({ item: items[i], score: s, idx: i });
  }
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((x) => x.item);
}
