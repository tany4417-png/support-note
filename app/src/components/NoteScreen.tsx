import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { addImageFromBlob } from "../lib/attachments";
import { accentClassFor } from "../lib/colors";
import { flattenFolderTree, listAllFolders } from "../lib/folders";
import { canRedo, canUndo, histInit, histPush, histRedo, histUndo, type Hist } from "../lib/history";
import { highlightMatches } from "../lib/highlight";
import { renderMarkdown, toggleCheckbox } from "../lib/markdown";
import type { Note } from "../lib/types";
import { BackIcon, CloseIcon, ImageIcon, RedoIcon, UndoIcon } from "./icons";
import { ImageOverlay, onImageDragStart } from "./ImageOverlay";
import { useAttachmentUrls } from "./useAttachmentUrls";

// 編集中の変更確定までの猶予（ms）。この間隔だけ入力が途切れたら、その時点のdraftを1スナップショットとしてhistoryへ積む
const HISTORY_COALESCE_MS = 600;
// 自動保存のデバウンス（ms）。入力がこの間隔だけ途切れたら未保存のdraftをDBへ書く
const AUTOSAVE_MS = 600;

type Props = {
  syncBar: React.ReactNode;
  // 画面切替（list/note/settings/trash）のスライドインクラス（slide-in-left/right）。ルート要素(.screen)に直接付ける
  slideClass: string;
  note: Note;
  startEditing?: boolean;
  onChange: (patch: { body?: string; importance?: 0 | 1 | 2 | 3; answered?: 0 | 1 }) => void;
  onDelete: () => void;
  onBack: () => void;
  // メモの移動（移動ピッカーで選んだ先）。App側でundo登録・同期スケジュールまで面倒を見る
  onMoveNote: (noteId: string, folderId: string | null) => void;
  // 画像添付が完了したときに呼ばれる（App側でscheduleSyncするためのフック）
  onAttached?: () => void;
  // 添付1枚の個別削除。App側でundo登録・同期スケジュールまで面倒を見る
  onDeleteAttachment: (attId: string) => void;
  // 検索から開いたときのハイライト・ジャンプ用クエリ。空なら何もしない
  highlightQuery?: string;
  // 自動保存。App側でupdateNote＋scheduleSyncのみ行い、グローバルundoには積まない
  onAutoSave: (body: string) => Promise<void>;
  // 編集セッション（編集開始〜完了/戻る）終了時、開始時と本文が変わっていた場合のみ呼ぶ。
  // App側でグローバルundoに1エントリ積む（細かい取り消しは編集中のローカルundo/redoが担当）
  onEditSessionEnd: (before: string, after: string) => void;
  // 「戻る」系遷移（バックスワイプ含む）の前にAppが未保存分をflushするための公開窓口。
  // performBack側はこれをawaitしてからdiscardIfEmptyNewを呼ぶ（物理削除と自動保存のレース防止）
  flushRef: React.RefObject<(() => Promise<void>) | null>;
};

export function NoteScreen({ syncBar, slideClass, note, startEditing, onChange, onDelete, onBack, onMoveNote, onAttached, onDeleteAttachment, highlightQuery, onAutoSave, onEditSessionEnd, flushRef }: Props) {
  const [editing, setEditing] = useState(startEditing ?? false);
  const [draft, setDraft] = useState(note.body);
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const html = useMemo(() => renderMarkdown(note.body), [note.body]);
  // dangerouslySetInnerHTMLに渡す{__html}はオブジェクトごとメモ化する。React 19は参照が変わると
  // 文字列が同値でもinnerHTMLを再設定するため、インライン生成だと無関係な再レンダー（allFolders到着等）で
  // ハイライトeffectが付けた<mark>が毎回消えてしまう
  const htmlObj = useMemo(() => ({ __html: html }), [html]);
  const allFolders = useLiveQuery(listAllFolders, [], []);
  const flatFolders = useMemo(() => flattenFolderTree(allFolders), [allFolders]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  // ジャンプ（scrollIntoView）は初回表示の1回だけ。チェックボックス切替等でhtmlが変わって
  // 再ハイライトしても、読んでいる位置を勝手に動かさない
  const jumpedRef = useRef(false);

  // undo/redo履歴。editing中だけ使い、historyRef自体はrefなので更新してもrenderされない。
  // canUndo/canRedoの表示（ボタンのdisabled）を更新するためだけに、値は使わずsetHistoryTickでrenderを誘発する
  const historyRef = useRef<Hist>(histInit(note.body));
  const [, setHistoryTick] = useState(0);
  const coalesceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 自動保存の状態。lastSaved=最後にDBへ書いた本文（note.bodyと比べない: 編集中に同期で
  // note.bodyが変わっても自動保存の判定を乱さないため）。sessionStart=編集セッション開始時の本文。
  const lastSavedRef = useRef(note.body);
  const sessionStartRef = useRef(note.body);
  // visibilitychange・flushRef・unmountクロージャから最新値を読むためのref
  const draftRef = useRef(draft);
  const editingRef = useRef(editing);
  useEffect(() => {
    draftRef.current = draft;
    editingRef.current = editing;
  });

  useEffect(() => {
    return () => {
      if (coalesceTimer.current) clearTimeout(coalesceTimer.current);
    };
  }, []);

  // 閲覧モードの本文に検索ヒットのハイライトを付け、最初のヒットへスクロールする。
  // dangerouslySetInnerHTMLはhtmlが変わらない限りDOMを再設定しないため、付けたmarkは再レンダーで消えない。
  // htmlが変わったとき（チェックボックス切替など）はinnerHTMLが素に戻るので、このeffectが付け直す
  useEffect(() => {
    if (editing) return;
    const root = viewRef.current;
    const q = (highlightQuery ?? "").trim();
    if (!root || !q) return;
    const first = highlightMatches(root, q);
    if (first && !jumpedRef.current) {
      jumpedRef.current = true;
      first.scrollIntoView({ block: "center" });
    }
  }, [html, editing, highlightQuery]);

  // 編集中、入力がAUTOSAVE_MSだけ途切れたら未保存のdraftをDBへ書く。
  // undo/redoボタン経由のdraft変更もこのeffectが自然に拾う
  useEffect(() => {
    if (!editing) return;
    if (draft === lastSavedRef.current) return;
    const t = setTimeout(() => {
      lastSavedRef.current = draft;
      void onAutoSave(draft);
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [draft, editing, onAutoSave]);

  // 未保存分の即時保存。編集中でなければ・未保存分が無ければno-op
  async function flushDraft() {
    if (!editingRef.current) return;
    if (draftRef.current === lastSavedRef.current) return;
    lastSavedRef.current = draftRef.current;
    await onAutoSave(draftRef.current);
  }

  // Appの戻り遷移（ボタン・バックスワイプ）がflushしてからdiscardIfEmptyNewできるよう窓口を公開する
  useEffect(() => {
    flushRef.current = flushDraft;
    return () => {
      flushRef.current = null;
    };
  });

  // アプリ切替・タブ非表示のタイミングでも未保存分を保存する（PWAはバックグラウンドでプロセスが落ち得る）
  useEffect(() => {
    if (!editing) return;
    const onVis = () => {
      if (document.visibilityState === "hidden") void flushDraft();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // flushDraftはref経由で最新を読むため依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // 編集したまま画面を離れた（戻る・削除等でunmount）場合のセッション終了。
  // 保存自体はperformBack側のflushRef経由（またはデバウンス済み）で済んでいる前提で、undoエントリだけ積む
  useEffect(() => {
    return () => {
      if (editingRef.current && draftRef.current !== sessionStartRef.current) {
        onEditSessionEnd(sessionStartRef.current, draftRef.current);
      }
    };
    // マウント時のonEditSessionEndを使う（note.idはこの画面の生存中不変）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 変更が続く間はタイマーを延長し、HISTORY_COALESCE_MSだけ途切れたらその時点のdraftを1スナップショットとして積む
  function scheduleSnapshot(next: string) {
    if (coalesceTimer.current) clearTimeout(coalesceTimer.current);
    coalesceTimer.current = setTimeout(() => {
      coalesceTimer.current = null;
      historyRef.current = histPush(historyRef.current, next);
      setHistoryTick((v) => v + 1);
    }, HISTORY_COALESCE_MS);
  }

  // undo/redo直前に未確定（coalescing待ち）の変更があれば、まずそれを1スナップショットとして積んでから操作する
  function flushPendingSnapshot() {
    if (coalesceTimer.current) {
      clearTimeout(coalesceTimer.current);
      coalesceTimer.current = null;
      historyRef.current = histPush(historyRef.current, draft);
    }
  }

  function onDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setDraft(next);
    scheduleSnapshot(next);
  }

  function undo() {
    flushPendingSnapshot();
    const h = histUndo(historyRef.current);
    historyRef.current = h;
    setDraft(h.present);
    setHistoryTick((v) => v + 1);
    textareaRef.current?.focus();
  }

  function redo() {
    flushPendingSnapshot();
    const h = histRedo(historyRef.current);
    historyRef.current = h;
    setDraft(h.present);
    setHistoryTick((v) => v + 1);
    textareaRef.current?.focus();
  }

  function startEdit() {
    if (coalesceTimer.current) {
      clearTimeout(coalesceTimer.current);
      coalesceTimer.current = null;
    }
    setDraft(note.body);
    lastSavedRef.current = note.body;
    sessionStartRef.current = note.body;
    historyRef.current = histInit(note.body);
    setHistoryTick(0);
    setEditing(true);
  }

  // 「完了」: 未保存分を保存し、セッションundoエントリを確定して閲覧モードへ戻る
  function finishEditing() {
    if (coalesceTimer.current) {
      clearTimeout(coalesceTimer.current);
      coalesceTimer.current = null;
    }
    if (draft !== lastSavedRef.current) {
      lastSavedRef.current = draft;
      void onAutoSave(draft);
    }
    if (draft !== sessionStartRef.current) {
      onEditSessionEnd(sessionStartRef.current, draft);
      sessionStartRef.current = draft;
    }
    setEditing(false);
    // メモをまたいで持ち越さないよう、編集終了でhistoryは破棄する
    historyRef.current = histInit(draft);
    setHistoryTick(0);
  }

  function moveTo(folderId: string | null) {
    if (folderId === note.folderId) return;
    onMoveNote(note.id, folderId);
    setMovePickerOpen(false);
  }

  function clickView(e: React.MouseEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.type === "checkbox") {
      const boxes = [...e.currentTarget.querySelectorAll('input[type="checkbox"]')];
      onChange({ body: toggleCheckbox(note.body, boxes.indexOf(t)) });
    }
  }

  // 選択・ペーストされたファイルのうち画像だけをattachments経由で保存し、保存完了ごとにonAttachedで同期をスケジュールする
  async function attachFiles(files: Iterable<File>) {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    for (const f of images) await addImageFromBlob(note.id, f);
    onAttached?.();
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) void attachFiles(files);
    e.target.value = ""; // 同じファイルを続けて選び直せるようにリセット
  }

  function onEditorPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault();
      void attachFiles(files);
    }
  }

  return (
    <div className={`note screen ${slideClass}`}>
      <div className="list-header">
        {syncBar}
        <div className="toolbar">
          {/* 1段目（オーナー指定配置）: 戻るだけ左、写真・移動…・編集/完了・削除は右揃え。
              画面幅で位置が変わらないよう常にこの並び固定 */}
          <div className="note-toolbar-row">
            <button className="icon-btn" onClick={onBack} aria-label="戻る">
              <BackIcon />
            </button>
            <span className="spacer" />
            <button className="icon-btn" aria-label="写真を添付" onClick={() => fileInputRef.current?.click()}>
              <ImageIcon />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={onPickFiles}
            />
            <button className="tint acc-violet" onClick={() => setMovePickerOpen((v) => !v)}>移動…</button>
            {editing ? (
              <button className="primary" onClick={finishEditing}>完了</button>
            ) : (
              <button className="tint acc-amber" onClick={startEdit}>編集</button>
            )}
            <button className="danger" onClick={onDelete}>削除</button>
          </div>
          {/* 2段目: ★★★・スペーサー・巻き戻し・やり直し（undo/redoは編集中のみ表示） */}
          <div className="note-toolbar-row">
            <span className="stars">
              {[1, 2, 3].map((i) => (
                <button
                  key={i}
                  className={note.importance >= i ? "star on" : "star"}
                  onClick={() => onChange({ importance: (note.importance === i ? i - 1 : i) as 0 | 1 | 2 | 3 })}
                >
                  ★
                </button>
              ))}
            </span>
            {/* 対応ステータスのトグル。未対応(0)なら対応済みへ、対応済み(1)なら未対応へ戻す */}
            <button
              className={note.answered === 0 ? "tint acc-green" : "tint acc-amber"}
              onClick={() => onChange({ answered: note.answered === 0 ? 1 : 0 })}
            >
              {note.answered === 0 ? "対応済みにする" : "未対応に戻す"}
            </button>
            <span className="spacer" />
            {editing && (
              <>
                <button className="icon-btn" aria-label="取り消し" disabled={!canUndo(historyRef.current)} onClick={undo}>
                  <UndoIcon />
                </button>
                <button className="icon-btn" aria-label="やり直し" disabled={!canRedo(historyRef.current)} onClick={redo}>
                  <RedoIcon />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      {movePickerOpen && (
        <div className="folder-picker">
          <div
            className={note.folderId === null ? "folder-picker-item disabled" : "folder-picker-item"}
            onClick={() => void moveTo(null)}
          >
            すべてのメモ
          </div>
          {flatFolders.map(({ folder, depth }) => (
            <div
              key={folder.id}
              className={`folder-picker-item ${accentClassFor(folder.name)}${note.folderId === folder.id ? " disabled" : ""}`}
              style={{ paddingLeft: `${12 + depth * 16}px` }}
              onClick={() => void moveTo(folder.id)}
            >
              {folder.name}
            </div>
          ))}
        </div>
      )}
      {/* ヘッダー（・移動ピッカー）以外＝本文・ギャラリーだけがスクロール＆バウンドする */}
      <div className="screen-body">
        {/* 内容が短くてもラバーバンドさせるため、中身全体を.bounce-areaで1枚ラップする（常にコンテナ＋1pxの高さ） */}
        <div className="bounce-area">
          {editing ? (
            <>
              {/* 編集中は貼った画像がすぐ見えるよう、ギャラリーを本文入力欄の上に置く（2026-07-21 オーナー要望）。
                  ×バッジ（1枚ずつ削除）も編集中だけ出す */}
              <Gallery noteId={note.id} showDeleteBadges onDeleteAttachment={onDeleteAttachment} />
              <textarea
                ref={textareaRef}
                className="editor"
                autoFocus
                value={draft}
                onChange={onDraftChange}
                onPaste={onEditorPaste}
              />
            </>
          ) : (
            <>
              {/* 本文が空のメモでは本文カードを出さない（空の枠だけ残ると小さな入力欄に見えるため）。
                  閲覧時の並びは文書として読む順を優先し、従来どおり本文→画像のまま */}
              {note.body.trim() !== "" && (
                <div ref={viewRef} className="note-view" onClick={clickView} dangerouslySetInnerHTML={htmlObj} />
              )}
              <Gallery noteId={note.id} onDeleteAttachment={onDeleteAttachment} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function Gallery({
  noteId,
  showDeleteBadges,
  onDeleteAttachment,
}: {
  noteId: string;
  // 編集中だけ各サムネの角に×バッジ（1枚ずつ削除）を出す
  showDeleteBadges?: boolean;
  onDeleteAttachment?: (attId: string) => void;
}) {
  // 一覧グリッドは軽いサムネイル、原寸オーバーレイだけ本体blobを使う（一覧・起動を重くしないため）
  const { metas, urls } = useAttachmentUrls(noteId, undefined, { thumb: true });
  // OSへのドラッグアウト用に、原寸blobのobjectURLも別途用意する（サムネのままだと画質が粗いため）。
  // 未取得（オフライン等でfetchが失敗した添付）はurlsに入らず、その添付はドラッグアウト無効のまま表示される
  const { urls: fullUrls } = useAttachmentUrls(noteId, undefined, { thumb: false });
  const [fullId, setFullId] = useState<string | null>(null);

  return (
    <>
      <div className="gallery">
        {metas.map(
          (m) =>
            urls[m.id] && (
              <span key={m.id} className="thumb-wrap">
                <img
                  className="thumb"
                  src={urls[m.id]}
                  onClick={() => setFullId(m.id)}
                  draggable={Boolean(fullUrls[m.id])}
                  onDragStart={(e) => onImageDragStart(e, m, fullUrls[m.id])}
                  alt=""
                />
                {showDeleteBadges && onDeleteAttachment && (
                  <button className="thumb-x" aria-label="この画像を削除" onClick={() => onDeleteAttachment(m.id)}>
                    <CloseIcon size={14} />
                  </button>
                )}
              </span>
            )
        )}
      </div>
      {/* 原寸表示（ズーム対応・body直下ポータル）はImageOverlayに分離 */}
      {(() => {
        const m = fullId ? metas.find((mm) => mm.id === fullId) : undefined;
        return m ? <ImageOverlay att={m} onClose={() => setFullId(null)} onDelete={onDeleteAttachment} /> : null;
      })()}
    </>
  );
}
