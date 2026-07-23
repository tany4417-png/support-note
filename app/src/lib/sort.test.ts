import { describe, expect, it } from "vitest";
import type { Note } from "./types";
import { searchNotes, sortNotes } from "./sort";

function n(id: string, over: Partial<Note> = {}): Note {
  return {
    id, body: id, importance: 0, createdAt: 0, updatedAt: 0, deleted: 0, dirty: 0, folderId: null,
    ...over,
  };
}

describe("sortNotes", () => {
  it("createdは作成の新しい順", () => {
    const r = sortNotes([n("a", { createdAt: 1 }), n("b", { createdAt: 3 }), n("c", { createdAt: 2 })], "created");
    expect(r.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("updatedは更新の新しい順", () => {
    const r = sortNotes([n("a", { updatedAt: 1 }), n("b", { updatedAt: 3 })], "updated");
    expect(r.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("importanceは星の多い順、同星は更新の新しい順", () => {
    const r = sortNotes(
      [n("a", { importance: 1, updatedAt: 5 }), n("b", { importance: 3 }), n("c", { importance: 1, updatedAt: 9 })],
      "importance"
    );
    expect(r.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("星3はcreated順でも先頭に固定される", () => {
    const r = sortNotes([n("a", { createdAt: 9 }), n("pin", { createdAt: 1, importance: 3 })], "created");
    expect(r.map((x) => x.id)).toEqual(["pin", "a"]);
  });

  it("元配列を破壊しない", () => {
    const src = [n("a", { createdAt: 1 }), n("b", { createdAt: 2 })];
    sortNotes(src, "created");
    expect(src.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("manualはorderKey昇順", () => {
    const r = sortNotes(
      [n("a", { orderKey: 2 }), n("b", { orderKey: 0 }), n("c", { orderKey: 1 })],
      "manual"
    );
    expect(r.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("manualはorderKey未設定(null)を末尾に回す", () => {
    const r = sortNotes(
      [n("nokey", { orderKey: null }), n("hasKey", { orderKey: 0 })],
      "manual"
    );
    expect(r.map((x) => x.id)).toEqual(["hasKey", "nokey"]);
  });

  it("manualでorderKeyが両方null同士はcreatedAt降順", () => {
    const r = sortNotes(
      [n("old", { orderKey: null, createdAt: 1 }), n("new", { orderKey: null, createdAt: 5 })],
      "manual"
    );
    expect(r.map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("manualは星3の上部固定を適用しない（純粋な手動順）", () => {
    const r = sortNotes(
      [n("normal", { orderKey: 0, importance: 0 }), n("pin", { orderKey: 1, importance: 3 })],
      "manual"
    );
    expect(r.map((x) => x.id)).toEqual(["normal", "pin"]);
  });
});

describe("searchNotes", () => {
  it("検索は本文の部分一致・大文字小文字無視", () => {
    const notes = [n("a", { body: "Cloudflare Workers" }), n("b", { body: "メモ" })];
    expect(searchNotes(notes, "cloud").map((x) => x.id)).toEqual(["a"]);
    expect(searchNotes(notes, "  ").map((x) => x.id)).toEqual(["a", "b"]);
  });
});
