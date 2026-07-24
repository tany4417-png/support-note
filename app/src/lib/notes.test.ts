import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDbForTests } from "./db";
import { createFolder } from "./folders";
import * as profile from "./profile";
import {
  createNote,
  discardIfEmptyNew,
  listActiveNotes,
  listTrashedNotes,
  purgeExpiredTrashLocal,
  restoreNote,
  softDeleteNote,
  sweepEmptyNewNotes,
  updateNote,
} from "./notes";

beforeEach(async () => {
  await resetDbForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("メモCRUD", () => {
  it("作成すると一覧に出て、dirty=1が付く", async () => {
    const n = await createNote("最初のメモ");
    expect(n.id).toHaveLength(26);
    expect(n.dirty).toBe(1);
    const list = await listActiveNotes();
    expect(list).toHaveLength(1);
    expect(list[0].body).toBe("最初のメモ");
  });

  it("folderId省略時はnull（既存呼び出しと互換）", async () => {
    const n = await createNote("body");
    expect(n.folderId).toBeNull();
  });

  it("folderIdを指定して作成できる", async () => {
    const n = await createNote("body", "FOLDER1");
    expect(n.folderId).toBe("FOLDER1");
  });

  it("設定済みの名前が新規メモのauthorになる", async () => {
    vi.spyOn(profile, "getUserName").mockReturnValue("山田");
    const n = await createNote("body");
    expect(n.author).toBe("山田");
  });

  it("名前未設定ならauthorはnull", async () => {
    vi.spyOn(profile, "getUserName").mockReturnValue(null);
    const n = await createNote("body");
    expect(n.author).toBeNull();
  });

  it("localStorage非対応環境（このファイルはnode環境で実行）でも例外にならずauthorはnull", async () => {
    // profileをモックせず本物のgetUserNameを通す。node環境にはlocalStorageが無いため、
    // ここが例外にならないことがgetUserName側の防御コードの回帰テストになる
    const n = await createNote("body");
    expect(n.author).toBeNull();
  });

  it("updateNoteでfolderIdを変更できる", async () => {
    const n = await createNote("body");
    const next = await updateNote(n.id, { folderId: "FOLDER2" });
    expect(next.folderId).toBe("FOLDER2");
    expect(next.dirty).toBe(1);
  });

  it("更新でupdatedAtが進みdirty=1に戻る", async () => {
    const n = await createNote("a");
    const before = n.updatedAt;
    const next = await updateNote(n.id, { body: "b", importance: 2 });
    expect(next.body).toBe("b");
    expect(next.importance).toBe(2);
    expect(next.updatedAt).toBeGreaterThanOrEqual(before);
    expect(next.dirty).toBe(1);
  });

  it("softDeleteで一覧から消える（レコードは残る）", async () => {
    const n = await createNote("消すメモ");
    await softDeleteNote(n.id);
    expect(await listActiveNotes()).toHaveLength(0);
  });
});

describe("ゴミ箱", () => {
  it("softDelete後、listTrashedNotesに載りlistActiveNotesには載らない", async () => {
    const n = await createNote("消すメモ");
    await softDeleteNote(n.id);
    const active = await listActiveNotes();
    const trashed = await listTrashedNotes();
    expect(active.find((x) => x.id === n.id)).toBeUndefined();
    expect(trashed.find((x) => x.id === n.id)).toBeDefined();
  });

  it("restoreNoteで戻り、dirty=1が付く", async () => {
    const n = await createNote("復元するメモ");
    await softDeleteNote(n.id);
    const restored = await restoreNote(n.id);
    expect(restored.deleted).toBe(0);
    expect(restored.dirty).toBe(1);
    const active = await listActiveNotes();
    expect(active.find((x) => x.id === n.id)).toBeDefined();
  });

  it("purgeExpiredTrashLocalは31日前に削除されたメモと添付を物理削除し、1日前のものは残す", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const old = await createNote("31日前に消えたメモ");
    await db.notes.update(old.id, { deleted: 1, updatedAt: now - 31 * day });
    await db.attachments.put({
      id: "att-old", noteId: old.id, mime: "image/png", size: 1,
      createdAt: now - 31 * day, updatedAt: now - 31 * day, deleted: 0, dirty: 0,
    });
    await db.attachmentBlobs.put({ id: "att-old", blob: new Blob([new Uint8Array([1])]) });

    const recent = await createNote("1日前に消えたメモ");
    await db.notes.update(recent.id, { deleted: 1, updatedAt: now - 1 * day });

    const purged = await purgeExpiredTrashLocal(now);
    expect(purged).toBe(1);

    expect(await db.notes.get(old.id)).toBeUndefined();
    expect(await db.attachments.get("att-old")).toBeUndefined();
    expect(await db.attachmentBlobs.get("att-old")).toBeUndefined();

    expect(await db.notes.get(recent.id)).toBeDefined();
  });

  it("purgeExpiredTrashLocalは31日超のフォルダtombstoneも物理削除し、1日前のものは残す", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const oldFolder = await createFolder("消えたフォルダ", null);
    await db.folders.update(oldFolder.id, { deleted: 1, updatedAt: now - 31 * day });

    const recentFolder = await createFolder("最近消えたフォルダ", null);
    await db.folders.update(recentFolder.id, { deleted: 1, updatedAt: now - 1 * day });

    const purged = await purgeExpiredTrashLocal(now);
    expect(purged).toBe(1);

    expect(await db.folders.get(oldFolder.id)).toBeUndefined();
    expect(await db.folders.get(recentFolder.id)).toBeDefined();
  });
});

describe("空メモの破棄（discardIfEmptyNew）", () => {
  it("未同期・無更新の空メモは物理削除される", async () => {
    const n = await createNote("");
    expect(await discardIfEmptyNew(n.id)).toBe("deleted");
    expect(await db.notes.get(n.id)).toBeUndefined();
  });

  it("本文が空白のみでも空とみなして物理削除する", async () => {
    const n = await createNote("  \n ");
    expect(await discardIfEmptyNew(n.id)).toBe("deleted");
  });

  it("本文があるメモは残る", async () => {
    const n = await createNote("メモ");
    expect(await discardIfEmptyNew(n.id)).toBe("kept");
    expect(await db.notes.get(n.id)).toBeDefined();
  });

  it("有効な添付があるメモは残る", async () => {
    const n = await createNote("");
    await db.attachments.put({
      id: "A1", noteId: n.id, mime: "image/png", size: 1, createdAt: 1, updatedAt: 1, deleted: 0, dirty: 1,
    });
    expect(await discardIfEmptyNew(n.id)).toBe("kept");
  });

  it("削除済み添付しか無ければ空とみなす", async () => {
    const n = await createNote("");
    await db.attachments.put({
      id: "A2", noteId: n.id, mime: "image/png", size: 1, createdAt: 1, updatedAt: 1, deleted: 1, dirty: 1,
    });
    expect(await discardIfEmptyNew(n.id)).toBe("deleted");
  });

  it("同期済み(dirty=0)の空メモは物理削除せずゴミ箱行き", async () => {
    const n = await createNote("");
    await db.notes.update(n.id, { dirty: 0 });
    expect(await discardIfEmptyNew(n.id)).toBe("trashed");
    expect((await db.notes.get(n.id))?.deleted).toBe(1);
  });

  it("空のまま保存してupdatedAtが進んだメモはゴミ箱行き", async () => {
    const n = await createNote("");
    // createNoteと同一msだとcreatedAt===updatedAtになり判定が変わるため確実にずらす
    await new Promise((r) => setTimeout(r, 10));
    await updateNote(n.id, { body: "" });
    expect(await discardIfEmptyNew(n.id)).toBe("trashed");
  });

  it("存在しないid・削除済みメモはkept（何もしない）", async () => {
    expect(await discardIfEmptyNew("MISSING")).toBe("kept");
    const n = await createNote("");
    await softDeleteNote(n.id);
    expect(await discardIfEmptyNew(n.id)).toBe("kept");
  });

  it("preferTrash指定時は未同期・無更新でも物理削除せずゴミ箱行き", async () => {
    const n = await createNote("");
    expect(await discardIfEmptyNew(n.id, { preferTrash: true })).toBe("trashed");
    expect((await db.notes.get(n.id))?.deleted).toBe(1);
  });

  it("物理削除は削除済み添付のメタ行とblobも一緒に消す", async () => {
    const n = await createNote("");
    await db.attachments.put({
      id: "A4", noteId: n.id, mime: "image/png", size: 1, createdAt: 1, updatedAt: 1, deleted: 1, dirty: 1,
    });
    await db.attachmentBlobs.put({ id: "A4", blob: new Blob([new Uint8Array([1])]) });
    expect(await discardIfEmptyNew(n.id)).toBe("deleted");
    expect(await db.attachments.get("A4")).toBeUndefined();
    expect(await db.attachmentBlobs.get("A4")).toBeUndefined();
  });
});

describe("起動時の空メモ掃除（sweepEmptyNewNotes）", () => {
  it("未同期・無更新・空のメモだけが消える", async () => {
    const target = await createNote("");
    const withBody = await createNote("本文あり");
    const synced = await createNote("");
    await db.notes.update(synced.id, { dirty: 0 });
    const withAtt = await createNote("");
    await db.attachments.put({
      id: "A3", noteId: withAtt.id, mime: "image/png", size: 1, createdAt: 1, updatedAt: 1, deleted: 0, dirty: 1,
    });

    expect(await sweepEmptyNewNotes()).toBe(1);
    expect(await db.notes.get(target.id)).toBeUndefined();
    expect(await db.notes.get(withBody.id)).toBeDefined();
    expect(await db.notes.get(synced.id)).toBeDefined();
    expect(await db.notes.get(withAtt.id)).toBeDefined();
  });
});
