import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { firstLineTitle } from "../lib/markdown";
import { BellIcon } from "./icons";

// 未対応（deleted=0 かつ answered=0）メモの仮想フォルダカード。一覧ルート最上部に置き、
// タップでPendingScreen（未対応メモの一覧）へ遷移する。実フォルダではないため
// SwipeableCardは使わない（スワイプ削除・D&D・並べ替えの対象外）。0件なら自ら非表示になる
export function PendingCard({ onOpen }: { onOpen: () => void }) {
  const pending = useLiveQuery(
    async () =>
      (await db.notes.toArray())
        .filter((n) => n.deleted === 0 && n.answered === 0)
        .sort((a, b) => a.createdAt - b.createdAt),
    [],
    null
  );
  if (!pending || pending.length === 0) return null;
  const count = pending.length;
  const shown = pending.slice(0, 3);
  const restCount = count - shown.length;
  return (
    <div className="card folder-card pending-folder" role="button" tabIndex={0} onClick={onOpen}>
      <div className="pending-folder-head">
        <BellIcon size={14} className="folder-icon" />
        <span className="folder-name">未対応</span>
        <span className="folder-count">{count}件</span>
      </div>
      <ul className="pending-titles">
        {shown.map((n) => (
          <li key={n.id}>{firstLineTitle(n.body)}</li>
        ))}
        {restCount > 0 && <li className="pending-more">ほか{restCount}件</li>}
      </ul>
    </div>
  );
}
