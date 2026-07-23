import { ulid } from "ulid";
import { db } from "./db";
import { thumbKey } from "./attachments";
import { getUserName } from "./profile";
import type { Note } from "./types";

export type NotePatch = Partial<
  Pick<Note, "body" | "importance" | "deleted" | "folderId" | "orderKey" | "answered">
>;

export async function createNote(body = "", folderId: string | null = null): Promise<Note> {
  const now = Date.now();
  const n: Note = {
    id: ulid(), body, importance: 0, createdAt: now, updatedAt: now, deleted: 0, dirty: 1, folderId, orderKey: null,
    author: getUserName(), answered: 0,
  };
  await db.notes.put(n);
  return n;
}

export async function updateNote(id: string, patch: NotePatch): Promise<Note> {
  // get→putを1トランザクションに包む。自動保存と★変更・移動が数msで交錯したとき、
  // 別トランザクションだと後着のputが先着の変更を巻き戻す（read-modify-writeのロストアップデート）
  return db.transaction("rw", db.notes, async () => {
    const cur = await db.notes.get(id);
    if (!cur) throw new Error(`note not found: ${id}`);
    const next: Note = { ...cur, ...patch, updatedAt: Date.now(), dirty: 1 };
    await db.notes.put(next);
    return next;
  });
}

export async function softDeleteNote(id: string): Promise<Note> {
  return updateNote(id, { deleted: 1 });
}

export async function listActiveNotes(): Promise<Note[]> {
  return (await db.notes.toArray()).filter((n) => n.deleted === 0);
}

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function listTrashedNotes(): Promise<Note[]> {
  return (await db.notes.toArray()).filter((n) => n.deleted === 1).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function restoreNote(id: string): Promise<Note> {
  return updateNote(id, { deleted: 0 });
}

export async function purgeExpiredTrashLocal(now = Date.now()): Promise<number> {
  const cutoff = now - TRASH_RETENTION_MS;
  const expired = (await db.notes.toArray()).filter((n) => n.deleted === 1 && n.updatedAt < cutoff);
  const expiredFolders = (await db.folders.toArray()).filter((f) => f.deleted === 1 && f.updatedAt < cutoff);
  if (expired.length === 0 && expiredFolders.length === 0) return 0;
  const ids = new Set(expired.map((n) => n.id));
  const atts = (await db.attachments.toArray()).filter((a) => ids.has(a.noteId));
  const folderIds = expiredFolders.map((f) => f.id);
  await db.transaction("rw", db.notes, db.attachments, db.attachmentBlobs, db.folders, async () => {
    await db.notes.bulkDelete([...ids]);
    await db.attachments.bulkDelete(atts.map((a) => a.id));
    await db.attachmentBlobs.bulkDelete(atts.flatMap((a) => [a.id, thumbKey(a.id)]));
    await db.folders.bulkDelete(folderIds);
  });
  return expired.length + expiredFolders.length;
}

// 空メモ判定: 本文が空白のみ、かつ有効な添付（deleted=0）が1件も無い。星（importance）は判定に含めない
// （星だけ付けた本文なしメモも空として扱う・設計書参照）
async function hasNoContent(n: Note): Promise<boolean> {
  if (n.body.trim() !== "") return false;
  const atts = await db.attachments.where("noteId").equals(n.id).toArray();
  return atts.every((a) => a.deleted === 1);
}

// 物理削除の本体。空メモ判定を通った時点で添付は全てdeleted=1のtombstoneなので、
// メタ行とblob（本体・サムネ）も一緒に消して孤児を残さない
async function hardDeleteNoteWithAttachments(id: string): Promise<void> {
  const atts = await db.attachments.where("noteId").equals(id).toArray();
  await db.transaction("rw", db.notes, db.attachments, db.attachmentBlobs, async () => {
    await db.notes.delete(id);
    await db.attachments.bulkDelete(atts.map((a) => a.id));
    await db.attachmentBlobs.bulkDelete(atts.flatMap((a) => [a.id, thumbKey(a.id)]));
  });
}

// 新規作成から何も入力せず戻ったときの後始末。未同期(dirty=1)かつ無更新(createdAt===updatedAt)なら
// この端末しか知らない個体なので物理削除する。それ以外（編集画面の表示中に同期が走った・空のまま保存した等）は
// サーバーが既に知っている可能性があり、ローカル物理削除だと次のpull（特にfull resync）で復活するため
// ゴミ箱行きにする（tombstoneとして同期され、30日の期限purgeで両側から消える）。
// preferTrash=trueは同期実行中の呼び出し用。物理削除はpushエコーバック適用と競合して空メモがdirty=0で復活しうるため、
// ゴミ箱行き（tombstoneはLWWで勝つ）に倒す
export async function discardIfEmptyNew(id: string, opts?: { preferTrash?: boolean }): Promise<"deleted" | "trashed" | "kept"> {
  const n = await db.notes.get(id);
  if (!n || n.deleted === 1) return "kept";
  if (!(await hasNoContent(n))) return "kept";
  if (!opts?.preferTrash && n.dirty === 1 && n.createdAt === n.updatedAt) {
    await hardDeleteNoteWithAttachments(id);
    return "deleted";
  }
  await softDeleteNote(id);
  return "trashed";
}

// 起動時の保険: アプリ強制終了・タブ閉じで「戻る」を通らず残った新規のままの空メモを物理削除する。
// 物理削除してよい条件はdiscardIfEmptyNewの物理削除側と同じ（未削除・未同期・無更新・空）
export async function sweepEmptyNewNotes(): Promise<number> {
  const candidates = (await db.notes.toArray()).filter(
    (n) => n.deleted === 0 && n.dirty === 1 && n.createdAt === n.updatedAt
  );
  let removed = 0;
  for (const n of candidates) {
    if (await hasNoContent(n)) {
      await hardDeleteNoteWithAttachments(n.id);
      removed += 1;
    }
  }
  return removed;
}
