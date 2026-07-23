import type { PushSender, SubRow } from "./push-sender";

export type CreatedEvent = { id: string; author?: string | null; body: string };
export type AnsweredDoneEvent = { id: string; body: string };
export type SyncEvents = { created: CreatedEvent[]; answeredDone: AnsweredDoneEvent[] };

// createdがこの件数以上のときは個別送信をやめ「新着 N件」1通に集約する
const CREATED_AGGREGATE_THRESHOLD = 4;

// 本文1行目の抜粋。空行はスキップし、見出し記法(#)は剥がして先頭60字に切り詰める。
// appのfirstLineTitle（app/src/lib/markdown.ts）相当だが、workerからappへの依存は持ち込めないため個別実装
function excerpt(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  const stripped = line.replace(/^#+\s*/, "").trim();
  return stripped === "" ? "(無題)" : stripped.slice(0, 60);
}

function authorLabel(author: string | null | undefined): string {
  return author && author.trim() !== "" ? author : "名前なし";
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
        await db.prepare("DELETE FROM push_subscriptions WHERE id=?").bind(sub.id).run();
      }
      // 404/410以外の失敗は無視する（再送なし）。1件の失敗が他の送信・tickの完走を止めない
    }
  }
}
