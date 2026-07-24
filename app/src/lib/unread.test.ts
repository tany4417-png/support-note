import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDbForTests } from "./db";
import { createNote, softDeleteNote } from "./notes";
import { clearUnread, markUnread, pruneUnread, syncAppBadge } from "./unread";

beforeEach(async () => {
  await resetDbForTests();
  vi.unstubAllGlobals();
});

describe("unread", () => {
  it("markUnreadで未読が積まれ、同じメモの再通知でも1件のまま", async () => {
    await markUnread("a");
    await markUnread("a");
    await markUnread("b");
    expect(await db.unread.count()).toBe(2);
  });

  it("clearUnreadで該当メモの未読だけ消える", async () => {
    await markUnread("a");
    await markUnread("b");
    await clearUnread("a");
    expect((await db.unread.toArray()).map((r) => r.noteId)).toEqual(["b"]);
  });

  it("pruneUnreadは存在するメモの未読を消さない", async () => {
    const alive = await createNote("残る");
    await markUnread(alive.id);
    await pruneUnread();
    expect((await db.unread.toArray()).map((r) => r.noteId)).toEqual([alive.id]);
  });

  it("pruneUnreadはdeleted!==0（ゴミ箱行き）のメモの未読行は消す", async () => {
    const trashed = await createNote("ゴミ箱行き");
    await softDeleteNote(trashed.id);
    await markUnread(trashed.id);
    await pruneUnread();
    expect(await db.unread.get(trashed.id)).toBeUndefined();
  });

  it("メモ未pull（ローカルにまだ存在しない）の未読行はpruneで消えない", async () => {
    // 他人が投稿した、この端末がまだpullしていない新着メモの可能性があるため、
    // 初回同期が終わる前に消してしまってはいけない（未読の赤点・バッジが早期に消える不具合の回帰）
    await markUnread("not-pulled-yet");
    await pruneUnread();
    expect((await db.unread.toArray()).map((r) => r.noteId)).toEqual(["not-pulled-yet"]);
  });

  it("7日を超えて放置された孤児未読行（ローカルに無いメモ）はpruneで消える", async () => {
    await db.unread.put({ noteId: "old-orphan", firedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
    await pruneUnread();
    expect(await db.unread.get("old-orphan")).toBeUndefined();
  });

  it("未読数がアプリアイコンバッジへ反映される（0件でクリア）", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const clear = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { setAppBadge: set, clearAppBadge: clear });
    await markUnread("a");
    expect(set).toHaveBeenCalledWith(1);
    await clearUnread("a");
    expect(clear).toHaveBeenCalled();
  });

  it("Badging API未対応環境（navigatorにsetAppBadge無し）でも例外にならない", async () => {
    vi.stubGlobal("navigator", {});
    await markUnread("a");
    await syncAppBadge();
    expect(await db.unread.count()).toBe(1);
  });
});
