import Dexie, { type Table, type Transaction } from "dexie";
import type { AttachmentMeta, Folder, Note, UnreadRow } from "./types";

export type AttachmentBlobRow = { id: string; blob: Blob };
export type MetaRow = { key: string; value: number | string };

// v1→v2アップグレード本体。folderIdフィールドが無い行にだけnullを補うのが本来の意図。
// 過去の不具合（Fix1恒久対策）: 同期で既にfolderIdの実データを受信済みの行にまで
// modify({ folderId: null }) が無条件適用され、updatedAtを変えずにサーバー側の値を
// ローカルだけnullで踏みつぶしていた。これがサーバーと「同時刻・別内容」の膠着を生む
// 原因になっていたため、folderIdが未定義（=本当にv1のまま一度もfolderId概念に触れていない
// 行）のときだけnullを補う形に直す。既存の値は絶対に上書きしない
export async function migrateNotesFolderId(tx: Transaction): Promise<void> {
  await tx
    .table("notes")
    .toCollection()
    .modify((note: Partial<Note> & { id: string }) => {
      if (note.folderId === undefined) note.folderId = null;
    });
}

export class SupportNoteDB extends Dexie {
  notes!: Table<Note, string>;
  attachments!: Table<AttachmentMeta, string>;
  attachmentBlobs!: Table<AttachmentBlobRow, string>;
  meta!: Table<MetaRow, string>;
  folders!: Table<Folder, string>;
  unread!: Table<UnreadRow, string>;

  constructor() {
    super("supportnote");
    this.version(1).stores({
      notes: "id, updatedAt, createdAt, importance, dirty",
      attachments: "id, noteId, updatedAt, dirty",
      attachmentBlobs: "id",
      meta: "key",
    });
    this.version(2)
      .stores({
        notes: "id, updatedAt, createdAt, importance, dirty, folderId",
        attachments: "id, noteId, updatedAt, dirty",
        attachmentBlobs: "id",
        meta: "key",
        folders: "id, parentId, updatedAt, dirty",
      })
      .upgrade(migrateNotesFolderId);
    this.version(3).stores({
      notes: "id, updatedAt, createdAt, importance, dirty, folderId",
      attachments: "id, noteId, updatedAt, dirty",
      attachmentBlobs: "id",
      meta: "key",
      folders: "id, parentId, updatedAt, dirty",
      unread: "noteId",
    });
  }
}

export const db = new SupportNoteDB();

export async function resetDbForTests(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
}
