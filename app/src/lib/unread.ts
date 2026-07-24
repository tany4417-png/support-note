import { db } from "./db";

// アプリアイコンの数字バッジ（Badging API・iOS 16.4+のPWA等）。未対応環境・権限なしはno-op。
// navigatorはウィンドウとSWの両方でグローバル解決されるため、このモジュールはsw.tsからも使える
async function updateAppBadge(count: number): Promise<void> {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) await nav.setAppBadge?.(count);
    else await nav.clearAppBadge?.();
  } catch {
    // バッジは補助表示。失敗で本処理（通知表示・未読記録）を巻き込まない
  }
}

// アイコンバッジを未読の実数に合わせる（起動・復帰時、SWが別コンテキストで積んだ分の反映）
export async function syncAppBadge(): Promise<void> {
  await updateAppBadge(await db.unread.count());
}

// push受信時（SWから呼ぶ）: 未読を積んでバッジ更新。putはupsertなので同一メモの再通知は1件のまま
export async function markUnread(noteId: string): Promise<void> {
  await db.unread.put({ noteId, firedAt: Date.now() });
  await syncAppBadge();
}

// メモを開いた時: 未読を解除してバッジ更新（未読が無いメモでもdeleteは冪等）
export async function clearUnread(noteId: string): Promise<void> {
  await db.unread.delete(noteId);
  await syncAppBadge();
}

// ローカルにまだ存在しない未読行を「孤児」とみなすまでの猶予。通知は「他人が投稿した、この端末が
// まだpullしていない新着メモ」を指すため、初回同期が終わる前にこの猶予内で消してしまうと
// 未読の赤点・バッジが早期に消える（実バグ）。猶予を超えても届かないままなら、配信されずに
// 失われた未読とみなして掃除する
const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// 起動時の掃除: (a) メモが存在してゴミ箱行き(deleted!==0)の未読、(b) ローカルに存在しないまま
// ORPHAN_GRACE_MSを超えて放置された未読、を除去する。(a)は削除経路（スワイプ削除・フォルダごと削除・
// 他端末の削除の同期）でclearUnreadを呼び漏れても自己修復するためのもの。(b)は未pullの新着メモを
// 誤って消さないよう、存在しないだけでは即削除しない
export async function pruneUnread(): Promise<void> {
  const now = Date.now();
  const rows = await db.unread.toArray();
  for (const r of rows) {
    const n = await db.notes.get(r.noteId);
    if (n) {
      if (n.deleted !== 0) await db.unread.delete(r.noteId);
      continue;
    }
    // firedAtが無い行（欠落・旧データ）は「今」を起点にみなし、この回では消さない
    const registeredAt = r.firedAt ?? now;
    if (now - registeredAt > ORPHAN_GRACE_MS) await db.unread.delete(r.noteId);
  }
  await syncAppBadge();
}
