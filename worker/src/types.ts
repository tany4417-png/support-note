export type NoteRecord = {
  id: string;
  body: string;
  importance: number;
  createdAt: number;
  updatedAt: number;
  deleted: 0 | 1;
  // 旧クライアントはこのフィールド自体を送らないことがある（upsertNoteはその場合folder_idを現状維持する）
  folderId?: string | null;
  // 旧クライアントはこのフィールド自体を送らないことがある（upsertNoteはその場合order_keyを現状維持する）
  orderKey?: number | null;
  // 旧クライアントはこのフィールド自体を送らないことがある（upsertNoteはその場合authorを現状維持する）
  author?: string | null;
  // 旧クライアントはこのフィールド自体を送らないことがある（upsertNoteはその場合answeredを現状維持する）
  answered?: 0 | 1;
};

export type AttachmentRecord = {
  id: string;
  noteId: string;
  mime: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  deleted: 0 | 1;
};

export type FolderRecord = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  deleted: 0 | 1;
  // 旧クライアントはこのフィールド自体を送らないことがある（upsertFolderはその場合order_keyを現状維持する）
  orderKey?: number | null;
};

export type SyncRequest = {
  since: number;
  notes: NoteRecord[];
  attachments: AttachmentRecord[];
  folders?: FolderRecord[];
  // 同期時サーバープッシュ通知の送信先から自分自身の端末を除外するための購読endpoint。
  // 未対応環境・未購読・取得失敗はnull（appのgetSelfEndpointがtry/catchで握る）
  selfEndpoint?: string | null;
  // 端末の識別子。編集中の申告が誰のものかの判定に使う。購読endpointは未購読端末でnullに
  // なるため使えない（NULL比較で解除が効かないか、無関係な端末どうしが互いの申告を解除する）
  clientId?: string | null;
  // 通知文の「誰が」に使う名前（端末ローカルの自己申告）
  actorName?: string | null;
  // その端末がいまメモ画面で開いているメモのid。開いていなければnull
  editingNoteId?: string | null;
  // 真のとき、このリクエストの変更を通知の保留に積まない（孤児救済の全量押し直し専用）
  suppressNotify?: boolean;
};
export type SyncResponse = { now: number; notes: NoteRecord[]; attachments: AttachmentRecord[]; folders: FolderRecord[]; purgedIds: string[] };
