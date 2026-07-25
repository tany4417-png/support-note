import type { Env } from "./index";
import type { AttachmentRecord, FolderRecord, NoteRecord, SyncRequest, SyncResponse } from "./types";
import { makeSender } from "./push-sender";
import { classifyNoteChange, excerpt, sendPending, type PriorNoteState } from "./notify";
import {
  addPending, claimDuePending, clearAnsweredBit, deletePending,
  releaseEditing, touchEditing, type PendingContext,
} from "./pending";

async function isPurged(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 FROM purged WHERE id = ?1`).bind(id).first();
  return row != null;
}

export type UpsertResult = "purged" | "applied" | "stale";

export async function upsertNote(db: D1Database, n: NoteRecord): Promise<UpsertResult> {
  if (await isPurged(db, n.id)) return "purged";
  const receivedAt = Date.now();
  const cols = ["id", "body", "importance", "created_at", "updated_at", "deleted", "received_at"];
  const vals: unknown[] = [n.id, n.body, n.importance, n.createdAt, n.updatedAt, n.deleted, receivedAt];
  const sets = ["body=excluded.body", "importance=excluded.importance", "updated_at=excluded.updated_at",
    "deleted=excluded.deleted", "received_at=excluded.received_at"];
  // 旧クライアント互換: フィールド自体が無ければ列に触れない（=現状維持）。明示的nullは書き込む
  if ("folderId" in n) { cols.push("folder_id"); vals.push(n.folderId ?? null); sets.push("folder_id=excluded.folder_id"); }
  if ("orderKey" in n) { cols.push("order_key"); vals.push(n.orderKey ?? null); sets.push("order_key=excluded.order_key"); }
  if ("author" in n) { cols.push("author"); vals.push(n.author ?? null); sets.push("author=excluded.author"); }
  if ("answered" in n) { cols.push("answered"); vals.push(n.answered ?? 0); sets.push("answered=excluded.answered"); }
  const sql = `INSERT INTO notes (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
    ON CONFLICT(id) DO UPDATE SET ${sets.join(",")}
    WHERE excluded.updated_at > notes.updated_at`;
  const res = await db.prepare(sql).bind(...vals).run();
  return (res.meta.changes ?? 0) > 0 ? "applied" : "stale";
}

export async function upsertAttachment(db: D1Database, a: AttachmentRecord): Promise<boolean> {
  if (await isPurged(db, a.id)) return false;
  await db.prepare(
    `INSERT INTO attachments (id, note_id, mime, size, created_at, updated_at, deleted, received_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       mime = excluded.mime, size = excluded.size,
       updated_at = excluded.updated_at, deleted = excluded.deleted, received_at = excluded.received_at
     WHERE excluded.updated_at > attachments.updated_at`
  ).bind(a.id, a.noteId, a.mime, a.size, a.createdAt, a.updatedAt, a.deleted, Date.now()).run();
  return true;
}

export async function upsertFolder(db: D1Database, f: FolderRecord): Promise<boolean> {
  if (await isPurged(db, f.id)) return false;
  // 旧クライアント対策: orderKeyフィールド自体が無い場合はorder_keyを現状維持する（notesのfolder_idと同じパターン）
  const hasOrderKey = "orderKey" in f;
  if (hasOrderKey) {
    await db.prepare(
      `INSERT INTO folders (id, name, parent_id, created_at, updated_at, deleted, received_at, order_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, parent_id = excluded.parent_id,
         updated_at = excluded.updated_at, deleted = excluded.deleted, received_at = excluded.received_at,
         order_key = excluded.order_key
       WHERE excluded.updated_at > folders.updated_at`
    ).bind(f.id, f.name, f.parentId ?? null, f.createdAt, f.updatedAt, f.deleted, Date.now(), f.orderKey ?? null).run();
  } else {
    await db.prepare(
      `INSERT INTO folders (id, name, parent_id, created_at, updated_at, deleted, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, parent_id = excluded.parent_id,
         updated_at = excluded.updated_at, deleted = excluded.deleted, received_at = excluded.received_at
       WHERE excluded.updated_at > folders.updated_at`
    ).bind(f.id, f.name, f.parentId ?? null, f.createdAt, f.updatedAt, f.deleted, Date.now()).run();
  }
  return true;
}

type NoteRow = {
  id: string; body: string; importance: number; created_at: number; updated_at: number;
  deleted: 0 | 1; folder_id: string | null; order_key: number | null;
  author: string | null; answered: 0 | 1;
};
type AttRow = { id: string; note_id: string; mime: string; size: number; created_at: number; updated_at: number; deleted: 0 | 1 };
type FolderRow = {
  id: string; name: string; parent_id: string | null; created_at: number; updated_at: number;
  deleted: 0 | 1; order_key: number | null;
};

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// 既知の限界: ゴミ箱保持30日＋このログ保持180日＝約210日以上同期しない端末には、
// その間に他端末で確定した削除が伝わらない（purgedログ自体が消えて削除スタブを合成できなくなるため）。
export const PURGED_LOG_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export async function purgeExpiredTrash(env: Env, now: number): Promise<void> {
  const cutoff = now - TRASH_RETENTION_MS;
  const expiredAtt = await env.DB.prepare(
    `SELECT id FROM attachments
     WHERE (deleted = 1 AND updated_at < ?1)
        OR note_id IN (SELECT id FROM notes WHERE deleted = 1 AND updated_at < ?1)`
  ).bind(cutoff).all<{ id: string }>();
  const expiredNotes = await env.DB.prepare(
    `SELECT id FROM notes WHERE deleted = 1 AND updated_at < ?1`
  ).bind(cutoff).all<{ id: string }>();
  const expiredFolders = await env.DB.prepare(
    `SELECT id FROM folders WHERE deleted = 1 AND updated_at < ?1`
  ).bind(cutoff).all<{ id: string }>();
  for (const row of expiredAtt.results) {
    await env.ATT.delete(`att/${row.id}`);
    await env.DB.prepare(`INSERT OR REPLACE INTO purged (id, purged_at, kind) VALUES (?1, ?2, 'att')`).bind(row.id, now).run();
  }
  for (const row of expiredNotes.results) {
    await env.DB.prepare(`INSERT OR REPLACE INTO purged (id, purged_at, kind) VALUES (?1, ?2, 'note')`).bind(row.id, now).run();
  }
  for (const row of expiredFolders.results) {
    await env.DB.prepare(`INSERT OR REPLACE INTO purged (id, purged_at, kind) VALUES (?1, ?2, 'folder')`).bind(row.id, now).run();
  }
  await env.DB.prepare(
    `DELETE FROM attachments
     WHERE (deleted = 1 AND updated_at < ?1)
        OR note_id IN (SELECT id FROM notes WHERE deleted = 1 AND updated_at < ?1)`
  ).bind(cutoff).run();
  await env.DB.prepare(`DELETE FROM notes WHERE deleted = 1 AND updated_at < ?1`).bind(cutoff).run();
  await env.DB.prepare(`DELETE FROM folders WHERE deleted = 1 AND updated_at < ?1`).bind(cutoff).run();
  await env.DB.prepare(`DELETE FROM purged WHERE purged_at < ?1`).bind(now - PURGED_LOG_RETENTION_MS).run();
}

export async function handleSync(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = (await req.json()) as SyncRequest;
  const now = Date.now();
  await purgeExpiredTrash(env, now);
  const purgedIds: string[] = [];
  const pctx: PendingContext = {
    clientId: body.clientId ?? null,
    actorName: body.actorName ?? null,
    selfEndpoint: body.selfEndpoint ?? null,
    editingNoteId: body.editingNoteId ?? null,
    now,
  };
  const suppressNotify = body.suppressNotify === true;
  for (const n of body.notes ?? []) {
    // upsert前の状態を読んでおく（変化の判定用。upsert自体はここでは何も参照しない）
    const prior = await env.DB.prepare(`SELECT answered, body FROM notes WHERE id=?1`)
      .bind(n.id).first<PriorNoteState>();
    const result = await upsertNote(env.DB, n);
    if (result === "purged") { purgedIds.push(n.id); continue; }
    if (result !== "applied") continue;
    if (n.deleted === 1) {
      // 未通知のまま消えたメモを後から通知しない
      await deletePending(env.DB, n.id);
      continue;
    }
    if (!suppressNotify) {
      const kinds = classifyNoteChange(prior, n);
      if (kinds !== 0) await addPending(env.DB, n.id, kinds, excerpt(n.body), pctx);
    }
    // 対応済みから未対応へ戻したら、未送信の対応済み通知を取り消す
    if (prior && prior.answered === 1 && n.answered === 0) await clearAnsweredBit(env.DB, n.id);
  }
  // 本文を変えずにメモ画面を開いたままの端末でも、既存の保留行の申告を延長する
  await touchEditing(env.DB, pctx);
  // 申告の解除は、変更の有無やsuppressNotifyに関わらず必ず行う
  await releaseEditing(env.DB, pctx);
  for (const a of body.attachments ?? []) {
    if (!(await upsertAttachment(env.DB, a))) purgedIds.push(a.id);
  }
  for (const f of body.folders ?? []) {
    if (!(await upsertFolder(env.DB, f))) purgedIds.push(f.id);
  }
  const noteRows = await env.DB.prepare(`SELECT * FROM notes WHERE received_at > ?1`).bind(body.since).all<NoteRow>();
  const attRows = await env.DB.prepare(`SELECT * FROM attachments WHERE received_at > ?1`).bind(body.since).all<AttRow>();
  const folderRows = await env.DB.prepare(`SELECT * FROM folders WHERE received_at > ?1`).bind(body.since).all<FolderRow>();
  const purgedRows = await env.DB.prepare(
    `SELECT id, purged_at, kind FROM purged WHERE kind IN ('note', 'folder') AND purged_at > ?1`
  ).bind(body.since).all<{ id: string; purged_at: number; kind: string }>();
  const noteStubs: NoteRecord[] = purgedRows.results.filter((r) => r.kind === "note").map((r) => ({
    id: r.id, body: "", importance: 0, createdAt: 0, updatedAt: r.purged_at, deleted: 1, folderId: null, orderKey: null,
    author: null, answered: 0,
  }));
  const folderStubs: FolderRecord[] = purgedRows.results.filter((r) => r.kind === "folder").map((r) => ({
    id: r.id, name: "", parentId: null, createdAt: 0, updatedAt: r.purged_at, deleted: 1, orderKey: null,
  }));
  const noteStubsAndRows: NoteRecord[] = [
    ...noteRows.results.map((r) => ({
      id: r.id, body: r.body, importance: r.importance,
      createdAt: r.created_at, updatedAt: r.updated_at, deleted: r.deleted, folderId: r.folder_id, orderKey: r.order_key,
      author: r.author, answered: r.answered,
    })),
    ...noteStubs,
  ];
  const res: SyncResponse = {
    now,
    notes: noteStubsAndRows,
    attachments: attRows.results.map((r) => ({
      id: r.id, noteId: r.note_id, mime: r.mime, size: r.size,
      createdAt: r.created_at, updatedAt: r.updated_at, deleted: r.deleted,
    })),
    folders: [
      ...folderRows.results.map((r) => ({
        id: r.id, name: r.name, parentId: r.parent_id,
        createdAt: r.created_at, updatedAt: r.updated_at, deleted: r.deleted, orderKey: r.order_key,
      })),
      ...folderStubs,
    ],
    purgedIds,
  };
  const due = await claimDuePending(env.DB, now);
  if (due.length > 0) {
    // 見出しは確定後の本文から作る。実体が消えていればtitle_hintを使う（sendPending内で分岐）
    const notesById = new Map<string, NoteRecord>();
    for (const r of due) {
      const cur = await env.DB.prepare(`SELECT * FROM notes WHERE id=?1`).bind(r.note_id).first<NoteRow>();
      if (cur) notesById.set(r.note_id, {
        id: cur.id, body: cur.body, importance: cur.importance, createdAt: cur.created_at,
        updatedAt: cur.updated_at, deleted: cur.deleted, folderId: cur.folder_id, orderKey: cur.order_key,
        author: cur.author, answered: cur.answered,
      });
    }
    ctx.waitUntil(sendPending(env.DB, makeSender(env), due, notesById, body.selfEndpoint ?? null));
  }
  return Response.json(res);
}
