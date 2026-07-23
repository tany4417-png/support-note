import type { Note } from "./types";

export type SortMode = "created" | "updated" | "importance" | "manual";

// 手動並べ替え順: orderKey昇順、未設定(null)は末尾、null同士はcreatedAt降順（従来の並びに近い順序）
function compareManual(a: Note, b: Note): number {
  const ao = a.orderKey ?? null;
  const bo = b.orderKey ?? null;
  if (ao === null && bo === null) return b.createdAt - a.createdAt;
  if (ao === null) return 1;
  if (bo === null) return -1;
  return ao - bo;
}

const comparers: Record<SortMode, (a: Note, b: Note) => number> = {
  created: (a, b) => b.createdAt - a.createdAt,
  updated: (a, b) => b.updatedAt - a.updatedAt,
  importance: (a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt,
  manual: compareManual,
};

export function sortNotes(notes: Note[], mode: SortMode): Note[] {
  const sorted = [...notes].sort(comparers[mode]);
  // 手動並べ替え中は星3固定を適用しない（純粋な手動順を尊重する）
  if (mode === "importance" || mode === "manual") return sorted;
  return [...sorted.filter((n) => n.importance === 3), ...sorted.filter((n) => n.importance !== 3)];
}

export function searchNotes(notes: Note[], query: string): Note[] {
  const q = query.trim().toLowerCase();
  if (!q) return notes;
  return notes.filter((n) => n.body.toLowerCase().includes(q));
}
