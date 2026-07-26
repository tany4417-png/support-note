import type { PushSender, SubRow } from "./push-sender";
import type { NoteRecord } from "./types";
import { KIND_ANSWERED, KIND_APPENDED, KIND_CREATED, type PendingRow } from "./pending";

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
// 除外は行ごとの actor_endpoint（＝その変化を起こした端末）だけで行う。同期リクエストの
// 送信元（selfEndpoint）は除外しない。5分の期限切れで回収されるときは、変化を起こした人と
// 同期を送ってきた人が別人になるため、送信元まで外すと無関係な端末が通知を取りこぼす
export async function sendPending(
  db: D1Database,
  send: PushSender,
  rows: PendingRow[],
  notesById: Map<string, NoteRecord>
): Promise<void> {
  if (rows.length === 0) return;
  const subsRes = await db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions").all<SubRow>();
  const subs = subsRes.results;
  if (subs.length === 0) return;
  for (const n of planNotifications(rows, notesById, subs)) {
    const payload = JSON.stringify({ noteId: n.noteId, title: n.title });
    for (const sub of subs) {
      if (n.exclude.has(sub.endpoint)) {
        console.log(`[notify] skip(excluded) sub=${sub.id} note=${n.noteId}`);
        continue;
      }
      const res = await send(sub, payload).catch(() => ({ ok: false as const, status: 0 }));
      // 診断用（2026-07-26〜。7/30の導入後に外す）。本文はログに出さない
      console.log(`[notify] sent sub=${sub.id} note=${n.noteId} ok=${res.ok} status=${res.status ?? "-"}`);
      if (!res.ok && (res.status === 404 || res.status === 410)) {
        // DELETE自体の失敗（D1の一時エラー等）でループを中断させない。消し損ねた行は
        // 次回以降の送信失敗時に再度DELETEが試みられるため、ここでは握りつぶして継続する
        await db.prepare("DELETE FROM push_subscriptions WHERE id=?").bind(sub.id).run().catch(() => {});
      }
      // 404/410以外の失敗は無視する（再送なし）。1件の失敗が他の送信を止めない
    }
  }
}
