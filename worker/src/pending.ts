export const KIND_CREATED = 1;
export const KIND_APPENDED = 2;
export const KIND_ANSWERED = 4;

// 編集中の申告の有効期間。書き手が申告を出すたびに now + この値へ延長する。
// 端末が落ちて解除の同期が来なくても、この時間で自然に切れて回収される
export const EDIT_HOLD_MS = 5 * 60 * 1000;

export type PendingRow = {
  note_id: string;
  kinds: number;
  actor: string | null;
  actor_endpoint: string | null;
  title_hint: string | null;
  editing_until: number;
  editing_client_id: string | null;
  last_change_at: number;
};

// 1回の同期リクエストから読み取れる「誰が・どの端末から・何を編集中か」。
// clientIdは購読の有無に依存しない端末の識別子（購読endpointは未購読端末でnullになるため、
// 一致判定に使うと解除が効かないか、無関係な端末どうしが互いの申告を解除してしまう）
export type PendingContext = {
  clientId: string | null;
  actorName: string | null;
  selfEndpoint: string | null;
  editingNoteId: string | null;
  now: number;
};

// 変化を1件積む。編集中の申告も同じ文で書く。行の作成と申告の反映を別の文に分けると、
// その隙間に別の端末の確保（claimDuePending）が入り、書きかけが通知される
export async function addPending(
  db: D1Database, noteId: string, kinds: number, titleHint: string, ctx: PendingContext
): Promise<void> {
  const editing = ctx.editingNoteId === noteId ? ctx.now + EDIT_HOLD_MS : 0;
  await db.prepare(
    `INSERT INTO pending_notifications
       (note_id, kinds, actor, actor_endpoint, title_hint, editing_until, editing_client_id, last_change_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(note_id) DO UPDATE SET
       kinds = pending_notifications.kinds | excluded.kinds,
       actor = excluded.actor,
       actor_endpoint = excluded.actor_endpoint,
       title_hint = excluded.title_hint,
       last_change_at = excluded.last_change_at,
       editing_until = MAX(pending_notifications.editing_until, excluded.editing_until),
       editing_client_id = CASE WHEN excluded.editing_until > 0
         THEN excluded.editing_client_id ELSE pending_notifications.editing_client_id END`
  ).bind(noteId, kinds, ctx.actorName, ctx.selfEndpoint, titleHint, editing, ctx.clientId, ctx.now).run();
}

// 本文を変えずにメモ画面を開いたままの端末が同期したとき、既存の保留行の申告だけを延長する。
// 保留行が無ければ何もしない（通知すべき変化が無いのだから、行を作る必要もない）
export async function touchEditing(db: D1Database, ctx: PendingContext): Promise<void> {
  if (!ctx.editingNoteId) return;
  await db.prepare(
    `UPDATE pending_notifications SET editing_until = ?1, editing_client_id = ?2 WHERE note_id = ?3`
  ).bind(ctx.now + EDIT_HOLD_MS, ctx.clientId, ctx.editingNoteId).run();
}

// 申告を解除する。条件は「同じ端末が出した申告で、いま申告しているメモとは別のもの」。
// 「申告が無いとき」だけを条件にすると、メモを閉じてすぐ別のメモを開いた場合に解除が漏れ、
// 最初のメモの通知が5分遅れる。note_id IS NOT ?2 はSQLiteのNULL安全比較で、
// editingNoteIdがnullなら全行が対象になる
export async function releaseEditing(db: D1Database, ctx: PendingContext): Promise<void> {
  if (!ctx.clientId) return;
  await db.prepare(
    `UPDATE pending_notifications SET editing_until = 0
     WHERE editing_client_id = ?1 AND note_id IS NOT ?2`
  ).bind(ctx.clientId, ctx.editingNoteId).run();
}

// 対応済みから未対応へ戻したときに、未送信の対応済み通知を取り消す。
// 残ったビットが指す変化の主体とずれるため、actorは更新しない
export async function clearAnsweredBit(db: D1Database, noteId: string): Promise<void> {
  await db.prepare(
    `UPDATE pending_notifications SET kinds = kinds & ~${KIND_ANSWERED} WHERE note_id = ?1`
  ).bind(noteId).run();
  await db.prepare(`DELETE FROM pending_notifications WHERE note_id = ?1 AND kinds = 0`).bind(noteId).run();
}

export async function deletePending(db: D1Database, noteId: string): Promise<void> {
  await db.prepare(`DELETE FROM pending_notifications WHERE note_id = ?1`).bind(noteId).run();
}

// 送信対象を確保する。削除と取得を1文で行い、選んでから消すまでの間に別の同期が
// 同じ行を選んで二重に送るのを防ぐ
export async function claimDuePending(db: D1Database, now: number): Promise<PendingRow[]> {
  const res = await db.prepare(
    `DELETE FROM pending_notifications WHERE editing_until <= ?1 RETURNING *`
  ).bind(now).all<PendingRow>();
  return res.results;
}

// 実体が物理削除された保留行の掃除。通常は削除時のdeletePendingで消えるが、
// ゴミ箱の期限purgeはnotesを直接消すため、ここで自己修復する
export async function purgeOrphanPending(db: D1Database): Promise<void> {
  await db.prepare(
    `DELETE FROM pending_notifications WHERE note_id NOT IN (SELECT id FROM notes)`
  ).run();
}
