import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { firstLineTitle, urlOnly } from "../lib/markdown";
import { makeSnippet } from "../lib/search";
import { planReorder, type ReorderPlan } from "../lib/reorder";
import type { SortMode } from "../lib/sort";
import type { Folder, Note } from "../lib/types";
import { Breadcrumb } from "./Breadcrumb";
import { CardThumbs } from "./CardThumbs";
import { FolderCard } from "./FolderCard";
import { BackIcon, CloseIcon } from "./icons";
import { type ReorderHandler, SwipeableCard } from "./SwipeableCard";

type Props = {
  syncBar: React.ReactNode;
  notes: Note[];
  sort: SortMode;
  onSort: (m: SortMode) => void;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  // 検索中はフォルダ横断表示になるモード。App側の判定を一本化して受け取る
  isBrowsingFolder: boolean;
  currentFolderId: string | null;
  // 画面切替（list/note/settings/trash）・フォルダ間移動共通のスライドインクラス（slide-in-left/right、
  // またはバックスワイプ完了時は空文字＝Fix3）。ルート要素(.screen)とフォルダ間移動時のコンテンツ部の
  // 両方に同じ値を使う（App.tsxのnavDirection・suppressSlideInから計算済み）
  slideClass: string;
  folderPath: Folder[];
  childFolders: Folder[];
  // フォルダカードで下の階層へ入る（進み操作）
  onOpenFolder: (id: string | null) => void;
  // パンくずで上位の階層（祖先）へ戻る（戻り操作）
  onNavigateUp: (id: string | null) => void;
  // ツールバーの「親フォルダへ戻る」ボタン。navigateBack（App.tsx）をそのまま渡す
  onBack: () => void;
  onCreateFolder: () => void;
  onRenameCurrentFolder: () => void;
  onDeleteFolder: (id: string) => void;
  onMoveNote: (noteId: string, folderId: string | null) => void;
  onMoveFolder: (id: string, parentId: string | null) => void;
  onReorderNote: (plan: ReorderPlan<{ id: string; orderKey: number | null }>) => void;
  onReorderFolder: (plan: ReorderPlan<{ id: string; orderKey: number | null }>) => void;
};

export function NoteList(p: Props) {
  const isBrowsingFolder = p.isBrowsingFolder;
  // スワイプで削除ボタンが開いているカードのid（メモ・フォルダ共通、開けるのは同時に1枚だけ）
  const [openId, setOpenId] = useState<string | null>(null);

  // 通知未読のメモid集合。カードの赤点表示用（未読はTask 3のunreadテーブル・端末ローカル）
  const unreadIds = useLiveQuery(
    async () => new Set((await db.unread.toArray()).map((u) => u.noteId)),
    [],
    new Set<string>()
  );

  // ドラッグ中のカードを他カードの前/後へ挿入する（同種のみ）。前後キーの計算はplanReorder（純関数）に委ね、
  // ここでは対象リスト（現在の表示順）を渡してApp側の書き込みハンドラへ計画を渡すだけにする
  const handleReorderNote: ReorderHandler = (draggedId, targetId, position) => {
    const items = p.notes.map((n) => ({ id: n.id, orderKey: n.orderKey ?? null }));
    const plan = planReorder(items, draggedId, targetId, position);
    if (plan) p.onReorderNote(plan);
  };
  const handleReorderFolder: ReorderHandler = (draggedId, targetId, position) => {
    const items = p.childFolders.map((f) => ({ id: f.id, orderKey: f.orderKey ?? null }));
    const plan = planReorder(items, draggedId, targetId, position);
    if (plan) p.onReorderFolder(plan);
  };

  return (
    <div className={`list screen ${p.slideClass}`}>
      <div className="list-header">
        {p.syncBar}
        <div className="toolbar">
          {isBrowsingFolder && p.folderPath.length > 0 && (
            <button className="icon-btn" aria-label="親フォルダへ戻る" onClick={p.onBack}>
              <BackIcon />
            </button>
          )}
          <div className="search-wrap">
            <input className="search" placeholder="検索" value={p.query} onChange={(e) => p.onQuery(e.target.value)} />
            {p.query !== "" && (
              <button
                className="search-clear"
                aria-label="検索をクリア"
                // mousedownのpreventDefaultで検索inputからフォーカスを奪わない（iPhone風: クリア後そのまま入力を続けられる）
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => p.onQuery("")}
              >
                <CloseIcon size={14} />
              </button>
            )}
          </div>
          <select value={p.sort} onChange={(e) => p.onSort(e.target.value as SortMode)}>
            <option value="created">新しい順</option>
            <option value="updated">更新順</option>
            <option value="importance">重要度順</option>
            <option value="manual">手動</option>
          </select>
          {isBrowsingFolder && (
            <button className="tint acc-teal" onClick={p.onCreateFolder}>フォルダ＋</button>
          )}
          <button className="primary" onClick={p.onCreate}>新規</button>
        </div>
        {isBrowsingFolder && (
          <Breadcrumb path={p.folderPath} onNavigate={p.onNavigateUp} onRenameCurrent={p.onRenameCurrentFolder} />
        )}
      </div>
      {/* ヘッダー以外（フォルダ/メモカード一覧）は.screen-bodyだけがスクロール＆バウンドする */}
      <div className="screen-body">
        {/* 内容が短くてもラバーバンドさせるため、中身全体を.bounce-areaで1枚ラップする（常にコンテナ＋1pxの高さ） */}
        <div className="bounce-area">
          {/* フォルダ間の移動でもスライドアニメを効かせるため、コンテンツ部だけkey={currentFolderId}で再マウントする。
              ヘッダー（.list-header）は含めない＝もうstickyではないがフォルダ移動時もガタつかせない。
              クラスは外側の.screenと同じp.slideClassを使う（バックスワイプ完了時は空文字で二重遷移を防ぐ・Fix3） */}
          <div
            className={`list-content ${p.slideClass}`}
            key={p.currentFolderId ?? "root"}
          >
            {isBrowsingFolder &&
              p.childFolders.map((f) => (
                <FolderCard
                  key={f.id}
                  folder={f}
                  isOpen={openId === f.id}
                  onOpenChange={(open) => setOpenId(open ? f.id : null)}
                  onCloseOthers={() => setOpenId((cur) => (cur === f.id ? cur : null))}
                  onOpen={() => p.onOpenFolder(f.id)}
                  onDelete={() => {
                    p.onDeleteFolder(f.id);
                    setOpenId((cur) => (cur === f.id ? null : cur));
                  }}
                  onMoveNote={p.onMoveNote}
                  onMoveFolder={p.onMoveFolder}
                  onReorder={handleReorderFolder}
                />
              ))}
            {p.notes.map((n) => (
              <SwipeableCard
                key={n.id}
                isOpen={openId === n.id}
                onOpenChange={(open) => setOpenId(open ? n.id : null)}
                onCloseOthers={() => setOpenId((cur) => (cur === n.id ? cur : null))}
                onDelete={() => {
                  p.onDelete(n.id);
                  setOpenId((cur) => (cur === n.id ? null : cur));
                }}
                onOpen={() => p.onOpen(n.id)}
                // 絞り込み中はドロップ先（フォルダ/パンくず）が画面に無いため、ドラッグ自体を始めさせない
                dragPayload={isBrowsingFolder ? { kind: "note", id: n.id } : undefined}
                currentLocationId={n.folderId}
                onMoveNote={p.onMoveNote}
                onMoveFolder={p.onMoveFolder}
                onReorder={handleReorderNote}
              >
                <div className="card-title">
                  {unreadIds.has(n.id) && <span className="unread-dot" aria-label="未読の通知" />}
                  {n.importance > 0 && <span className="card-stars">{"★".repeat(n.importance)}</span>}
                  {(() => {
                    const url = urlOnly(n.body);
                    return url ? (
                      <a className="card-link" href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                        {url}
                      </a>
                    ) : n.body.trim() === "" ? null : (
                      firstLineTitle(n.body)
                    );
                  })()}
                </div>
                {/* 検索中だけ該当箇所の抜粋を出す（タップでその位置へ飛べることの手がかり） */}
                {!isBrowsingFolder &&
                  (() => {
                    const s = makeSnippet(n.body, p.query);
                    return (
                      s && (
                        <div className="card-snippet">
                          {s.before}
                          <mark className="search-hit">{s.match}</mark>
                          {s.after}
                        </div>
                      )
                    );
                  })()}
                <CardThumbs noteId={n.id} />
                <div className="card-sub">{new Date(n.updatedAt).toLocaleString("ja-JP")}</div>
              </SwipeableCard>
            ))}
            {p.notes.length === 0 && (
              <p className="empty">まだメモがありません。「新規」から書き始めるか、URLや画像を貼り付けてください。</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
