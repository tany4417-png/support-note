export type Note = {
  id: string;
  body: string;
  importance: 0 | 1 | 2 | 3;
  createdAt: number;
  updatedAt: number;
  deleted: 0 | 1;
  dirty: 0 | 1;
  folderId: string | null;
  // 手動並べ替え用の順序キー。null=未設定（旧データ・新規作成直後）。任意欄はfolderId導入前の既存Dexieレコードとの互換のため
  orderKey?: number | null;
  // メモに表示する投稿者名（記名）。createNoteが作成時点のgetUserName()を設定する。未設定端末での作成はnull
  author: string | null;
  // 対応済みフラグ（Task 5用）。既定は0
  answered: 0 | 1;
};

export type AttachmentMeta = {
  id: string;
  noteId: string;
  mime: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  deleted: 0 | 1;
  dirty: 0 | 1;
};

export type Folder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  deleted: 0 | 1;
  dirty: 0 | 1;
  orderKey?: number | null;
};

export type SyncResponse = {
  now: number;
  notes: Omit<Note, "dirty">[];
  attachments: Omit<AttachmentMeta, "dirty">[];
  folders?: Omit<Folder, "dirty">[];
  purgedIds?: string[];
};

// 通知の未読記録（端末ローカル・同期しない）。push受信時にSWが積み、メモを開いたら消す
export type UnreadRow = { noteId: string; firedAt: number };
