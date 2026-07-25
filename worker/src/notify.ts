import type { PushSender, SubRow } from "./push-sender";
import type { NoteRecord } from "./types";
import { KIND_ANSWERED, KIND_APPENDED, KIND_CREATED, type PendingRow } from "./pending";

export type CreatedEvent = { id: string; author?: string | null; body: string };
export type AnsweredDoneEvent = { id: string; body: string };
export type SyncEvents = { created: CreatedEvent[]; answeredDone: AnsweredDoneEvent[] };

// createdがこの件数以上のときは個別送信をやめ「新着 N件」1通に集約する
const CREATED_AGGREGATE_THRESHOLD = 4;

// 本文1行目の抜粋。空行はスキップし、見出し記法(#)は剥がして先頭60字に切り詰める。
// appのfirstLineTitle（app/src/lib/markdown.ts）相当だが、workerからappへの依存は持ち込めないため個別実装
export function excerpt(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  const stripped = line.replace(/^#+\s*/, "").trim();
  return stripped === "" ? "(無題)" : stripped.slice(0, 60);
}

function authorLabel(author: string | null | undefined): string {
  return author && author.trim() !== "" ? author : "名前なし";
}

export type PriorNoteState = { answered: 0 | 1; body: string };

// 通知すべき変化の種類をビットで返す。同期セマンティクス（LWW等）には関与せず、
// upsert前の状態(prior)と届いたレコードを見るだけの純粋関数。
// 本文は「文字数が増えたとき」だけ追記とする。差分全般にすると、誤字修正や
// チェックボックスの切り替え（[ ]→[x]。文字数は変わらない）でも返信通知が飛ぶ
export function classifyNoteChange(prior: PriorNoteState | null, n: NoteRecord): number {
  if (n.deleted === 1) return 0;
  if (prior == null) return KIND_CREATED;
  let kinds = 0;
  if (n.body.length > prior.body.length) kinds |= KIND_APPENDED;
  if (prior.answered === 0 && n.answered === 1) kinds |= KIND_ANSWERED;
  return kinds;
}

// 通知1通の見出しを作る。新規が立っていれば他の変化が重なっていても新規として扱い、
// 名前は変更者ではなく作成者（notes.author）から取る
export function buildTitle(row: PendingRow, note: NoteRecord | undefined): string {
  const title = note ? excerpt(note.body) : (row.title_hint ?? "(無題)");
  if (row.kinds & KIND_CREATED) return `${authorLabel(note?.author ?? row.actor)}: ${title}`;
  const who = authorLabel(row.actor);
  // 投稿者本人が書き足した場合は「追記」。本人の補足まで「返信」と出すと、
  // 回答が来ていないのに来たと読める
  const isAuthor = note != null && note.author != null && note.author === row.actor;
  const appended = row.kinds & KIND_APPENDED;
  const answered = row.kinds & KIND_ANSWERED;
  if (appended && answered) return `${who}が${isAuthor ? "追記" : "返信"}して対応済みに: ${title}`;
  if (appended) return `${who}が${isAuthor ? "追記" : "返信"}: ${title}`;
  return `${who}が対応済みに: ${title}`;
}

function buildNotifications(events: SyncEvents): { noteId: string; title: string }[] {
  const notes: { noteId: string; title: string }[] = [];
  if (events.created.length >= CREATED_AGGREGATE_THRESHOLD) {
    notes.push({ noteId: events.created[0].id, title: `新着 ${events.created.length}件` });
  } else {
    for (const c of events.created) {
      notes.push({ noteId: c.id, title: `${authorLabel(c.author)}: ${excerpt(c.body)}` });
    }
  }
  for (const a of events.answeredDone) {
    notes.push({ noteId: a.id, title: `対応済み: ${excerpt(a.body)}` });
  }
  return notes;
}

// 同期処理中に観察された新着/対応済み遷移を、購読中の他端末へWeb Pushで通知する。
// 1件の送信失敗（例外含む）が他の購読への送信・全体の完走を妨げないこと、selfEndpointの
// 除外、404/410購読の自動削除がこの関数の責務。同期セマンティクス（LWW等）には一切関与しない
export async function notifySyncEvents(
  db: D1Database,
  send: PushSender,
  events: SyncEvents,
  selfEndpoint?: string | null
): Promise<void> {
  const notifications = buildNotifications(events);
  if (notifications.length === 0) return;
  const subsRes = await db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions").all<SubRow>();
  const subs = subsRes.results.filter((s) => s.endpoint !== selfEndpoint);
  if (subs.length === 0) return;
  for (const n of notifications) {
    const payload = JSON.stringify({ noteId: n.noteId, title: n.title });
    for (const sub of subs) {
      const res = await send(sub, payload).catch(() => ({ ok: false as const, status: 0 }));
      if (!res.ok && (res.status === 404 || res.status === 410)) {
        // DELETE自体の失敗（D1の一時エラー等）でループを中断させない。消し損ねた行は
        // 次回以降の送信失敗時に再度DELETEが試みられるため、ここでは握りつぶして継続する
        await db.prepare("DELETE FROM push_subscriptions WHERE id=?").bind(sub.id).run().catch(() => {});
      }
      // 404/410以外の失敗は無視する（再送なし）。1件の失敗が他の送信・tickの完走を止めない
    }
  }
}

// 1回の送信でこの件数以上になったら、個別送信をやめて「更新 N件」1通に集約する。
// 初版のCREATED_AGGREGATE_THRESHOLDを引き継いだ値。ただし初版が新規メモだけを
// 数えていたのに対し、ここでは保留行の総数で数える
export const AGGREGATE_THRESHOLD = 4;

type Outgoing = { noteId: string; title: string; exclude: Set<string> };

function excludeOf(rows: PendingRow[]): Set<string> {
  return new Set(rows.map((r) => r.actor_endpoint).filter((e): e is string => e != null));
}

// 確保済みの保留行を通知へ組み立てる。集約すると宛先が1台も残らない場合は、
// 4件分の変化が誰にも伝わらなくなるため、個別送信に落とす
function planNotifications(rows: PendingRow[], notesById: Map<string, NoteRecord>, subs: SubRow[]): Outgoing[] {
  const individual = (): Outgoing[] =>
    rows.map((r) => ({
      noteId: r.note_id,
      title: buildTitle(r, notesById.get(r.note_id)),
      exclude: excludeOf([r]),
    }));
  if (rows.length < AGGREGATE_THRESHOLD) return individual();
  const exclude = excludeOf(rows);
  if (subs.every((s) => exclude.has(s.endpoint))) return individual();
  const oldest = rows.reduce((a, b) => (b.last_change_at < a.last_change_at ? b : a));
  return [{ noteId: oldest.note_id, title: `更新 ${rows.length}件`, exclude }];
}

// 確保済みの保留行を購読中の端末へ送る。1件の送信失敗（例外含む）が他の購読への送信を
// 妨げないこと、変更者の端末の除外、404/410購読の自動削除がこの関数の責務。
// 同期セマンティクス（LWW等）には一切関与しない
export async function sendPending(
  db: D1Database,
  send: PushSender,
  rows: PendingRow[],
  notesById: Map<string, NoteRecord>,
  selfEndpoint: string | null
): Promise<void> {
  if (rows.length === 0) return;
  const subsRes = await db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions").all<SubRow>();
  const subs = subsRes.results;
  if (subs.length === 0) return;
  for (const n of planNotifications(rows, notesById, subs)) {
    const payload = JSON.stringify({ noteId: n.noteId, title: n.title });
    for (const sub of subs) {
      if (n.exclude.has(sub.endpoint) || sub.endpoint === selfEndpoint) continue;
      const res = await send(sub, payload).catch(() => ({ ok: false as const, status: 0 }));
      if (!res.ok && (res.status === 404 || res.status === 410)) {
        // DELETE自体の失敗（D1の一時エラー等）でループを中断させない。消し損ねた行は
        // 次回以降の送信失敗時に再度DELETEが試みられるため、ここでは握りつぶして継続する
        await db.prepare("DELETE FROM push_subscriptions WHERE id=?").bind(sub.id).run().catch(() => {});
      }
      // 404/410以外の失敗は無視する（再送なし）。1件の失敗が他の送信を止めない
    }
  }
}
