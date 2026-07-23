import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { firstLineTitle } from "../lib/markdown";
import { BackIcon } from "./icons";

type Props = {
  syncBar: React.ReactNode;
  // 画面切替（list/note/settings/trash/pending）のスライドインクラス（slide-in-left/right）。ルート要素(.screen)に直接付ける
  slideClass: string;
  onBack: () => void;
  // 行タップでメモを開く。一覧タップと同じ関数（App.tsx）を渡す
  onOpenNote: (id: string) => void;
};

// 未対応（deleted=0 かつ answered=0）メモを作成が古い順に列挙するだけの画面。
// スワイプ削除等は不要（読む→開くだけ）なのでSwipeableCardは使わない
export function PendingScreen({ syncBar, slideClass, onBack, onOpenNote }: Props) {
  const notes = useLiveQuery(
    async () =>
      (await db.notes.toArray())
        .filter((n) => n.deleted === 0 && n.answered === 0)
        .sort((a, b) => a.createdAt - b.createdAt),
    [],
    []
  );

  return (
    <div className={`pending screen ${slideClass}`}>
      <div className="list-header">
        {syncBar}
        <div className="toolbar">
          <button className="icon-btn" onClick={onBack} aria-label="戻る">
            <BackIcon />
          </button>
          <h2>未対応</h2>
        </div>
      </div>
      <div className="screen-body">
        {/* 内容が短くてもラバーバンドさせるため、中身全体を.bounce-areaで1枚ラップする（常にコンテナ＋1pxの高さ） */}
        <div className="bounce-area">
          {notes.map((n) => (
            <div key={n.id} className="card pending-card" onClick={() => onOpenNote(n.id)}>
              {n.body.trim() !== "" && <div className="card-title">{firstLineTitle(n.body)}</div>}
              <div className="card-sub">
                {new Date(n.createdAt).toLocaleString("ja-JP")}
                {n.author && <span className="card-author">{n.author}</span>}
              </div>
            </div>
          ))}
          {notes.length === 0 && <p className="empty">未対応のメモはありません</p>}
        </div>
      </div>
    </div>
  );
}
