import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { NameGate } from "./components/NameGate";
import { NoteList } from "./components/NoteList";
import { NoteScreen } from "./components/NoteScreen";
import { PendingScreen } from "./components/PendingScreen";
import { Settings } from "./components/Settings";
import { SyncStatus } from "./components/SyncStatus";
import { TrashScreen } from "./components/TrashScreen";
import { popRedo, popUndo, pushAction, type ActionStacks } from "./lib/actions";
import { addImageFromBlob, restoreAttachment, softDeleteAttachment } from "./lib/attachments";
import { db } from "./lib/db";
import { exportZip, localYmd } from "./lib/export";
import { ensurePushSubscription, isPushEnabled } from "./lib/push";
import {
  countOrphans,
  createFolder,
  deleteFolderWithContents,
  folderPath,
  listChildFolders,
  moveFolder,
  moveNote,
  renameFolder,
  reorderFolder,
  reorderNote,
  repairOrphans,
  restoreFolderWithContents,
  updateFolder,
} from "./lib/folders";
import { shouldCompleteBack } from "./lib/gesture";
import { saveToken } from "./lib/invite";
import { createNote, discardIfEmptyNew, listActiveNotes, purgeExpiredTrashLocal, restoreNote, softDeleteNote, sweepEmptyNewNotes, updateNote, type NotePatch } from "./lib/notes";
import { getUserName } from "./lib/profile";
import type { ReorderPlan } from "./lib/reorder";
import { searchNotes, sortNotes, type SortMode } from "./lib/sort";
import { runSync } from "./lib/sync";
import { clearUnread, pruneUnread, syncAppBadge } from "./lib/unread";

type View =
  | { name: "list" }
  | { name: "note"; id: string; isNew?: boolean }
  | { name: "settings" }
  | { name: "trash" }
  | { name: "pending" };

// メモ内容の変更（App onChangeハンドラ経由）の操作ラベル。undo/redoボタンの表示にのみ使う
function labelForNotePatch(patch: NotePatch): string {
  if ("importance" in patch) return "重要度を変更";
  if ("answered" in patch) return patch.answered === 1 ? "対応済みにする" : "未対応に戻す";
  if ("body" in patch) return "本文を変更";
  return "メモを編集";
}

export default function App() {
  const [view, setView] = useState<View>({ name: "list" });
  // 画面遷移のスライド方向。戻り系（navigateBack・各画面の←ボタン・パンくずで上位へ）で"back"、
  // それ以外の遷移（新規作成・メモを開く・設定/ゴミ箱を開く・フォルダへ入るなど）で"forward"をセットする
  const [navDirection, setNavDirection] = useState<"forward" | "back">("forward");
  // バックスワイプ（指の追従）が完了して発生した遷移では、ドラッグ自体が遷移の動きなので追加の
  // slide-inアニメを再生しない（Fix3）。ボタン・パンくず経由の「戻る」や通常の進み操作では
  // 遷移のたびに毎回falseへ明示的に戻すため、専用のリセット処理は不要
  const [suppressSlideIn, setSuppressSlideIn] = useState(false);
  const [sort, setSortState] = useState<SortMode>(() => (localStorage.getItem("supportnote.sort") as SortMode) ?? "created");
  const setSort = (m: SortMode) => {
    localStorage.setItem("supportnote.sort", m);
    setSortState(m);
  };
  const [query, setQuery] = useState("");
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [token, setToken] = useState(() => localStorage.getItem("supportnote.token") ?? "");
  // 記名（メモに表示する投稿者名）。未設定の間はNameGateだけを描画する（下のreturn分岐参照）
  const [userName, setUserNameState] = useState(() => getUserName());
  const [status, setStatus] = useState<"idle" | "syncing" | "offline" | "error">("idle");
  const [lastSync, setLastSync] = useState<number | null>(null);
  // 直近のrunSyncで失敗した添付PUTの件数。0より大きい間はSyncStatusのラベルに「次回再送」の注記を出す
  const [failedAttachments, setFailedAttachments] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const syncing = useRef(false);
  // 起動時初期化（空メモ掃除等）の完了Promise。syncNowはこれを待ってから走る（下の初期化effect参照）
  const initCleanupRef = useRef<Promise<void>>(Promise.resolve());
  // NoteScreenの未保存draftを戻り遷移の前にflushするための窓口（NoteScreenがマウント中だけ非null）
  const noteFlushRef = useRef<(() => Promise<void>) | null>(null);
  // main（.app）要素そのものへの参照。追従スワイプ中に現在マウント中の.screenをquerySelectorで
  // 見つけてtranslateXを直接書き込む（Reactのstateを介さないため、カード枚数が多い一覧でも重くならない）
  const mainRef = useRef<HTMLElement | null>(null);
  // 背景の右フリック（iOS風の戻るジェスチャー）検出用。pointerdown時の座標・時刻を覚えておき、
  // 追従スワイプの起点にする。カード等の操作要素上や、戻り先が無い場面でのpointerdownではnullのままにして無効化する
  const backSwipeStart = useRef<{ x: number; y: number; t: number } | null>(null);
  // 追従スワイプ中かどうか（dx>10・横優勢になった時点でtrueになる）。trueの間だけ.screenへtranslateXを反映し、
  // touchmove側で縦スクロールをpreventDefaultする
  const followingBack = useRef(false);
  // 追従スワイプ中に直接styleを書き換える対象（pointerdown時点でマウントされている.screen要素）
  const dragScreenEl = useRef<HTMLElement | null>(null);
  // followingBack.current（ref）と同じ値を保つstate。document側のpointerup/pointercancelフォールバック
  // リスナー（下のuseEffect）の張り外しだけに使う。ホットパス（pointermoveのたび）では更新しないため、
  // 追従中の高頻度な再レンダーは起きない
  const [isFollowingBack, setIsFollowingBack] = useState(false);
  // 追従開始から一定時間pointermoveが来なければ「取り逃し」とみなして強制リセットするウォッチドッグ
  const backSwipeWatchdog = useRef<number | undefined>(undefined);
  // グローバルundo/redo（削除・移動・並べ替え・内容変更の操作履歴）。メモリ内のみ＝リロードで消える
  const [stacks, setStacks] = useState<ActionStacks>({ past: [], future: [] });

  // 追従スワイプ状態の後始末を1箇所に集約する（未達での指離し・縦スクロールへの移行・pointercancel・
  // documentフォールバック・visibilitychange/blur・ウォッチドッグタイマー、すべての経路からここを呼ぶ）。
  // pointerupを取り逃してtransformが途中で止まったまま・touchmoveのpreventDefaultが効き続けたまま
  // 操作不能になる事態への防御。追従中だった場合のみ.screenをtranslateX(0)へ150ms transitionで戻す
  const resetBackSwipe = useCallback(() => {
    window.clearTimeout(backSwipeWatchdog.current);
    backSwipeWatchdog.current = undefined;
    const el = dragScreenEl.current;
    if (el && followingBack.current) {
      el.style.transition = "transform 150ms ease";
      el.style.transform = "translateX(0px)";
    }
    backSwipeStart.current = null;
    followingBack.current = false;
    setIsFollowingBack(false);
    dragScreenEl.current = null;
  }, []);

  // バックスワイプが完了（しきい値超え）した場合の後始末。ドラッグ自体が遷移の動きなので、
  // resetBackSwipe（キャンセル時の150ms巻き戻し）と違い、transitionを掛けずに即座にtranslateX(0)へ
  // リセットする。この直後にslide-inアニメ無しで新しい内容へ切り替わるため、ここで動きを作らない（Fix3）
  const completeBackSwipe = useCallback(() => {
    window.clearTimeout(backSwipeWatchdog.current);
    backSwipeWatchdog.current = undefined;
    const el = dragScreenEl.current;
    if (el) {
      el.style.transition = "none";
      el.style.transform = "translateX(0px)";
    }
    backSwipeStart.current = null;
    followingBack.current = false;
    setIsFollowingBack(false);
    dragScreenEl.current = null;
  }, []);

  const notes = useLiveQuery(listActiveNotes, [], []);
  const pending = useLiveQuery(
    async () => (await db.notes.where("dirty").equals(1).count()) + (await db.attachments.where("dirty").equals(1).count()),
    [],
    0
  );
  const childFolders = useLiveQuery(() => listChildFolders(currentFolderId), [currentFolderId], []);
  const folderPathList = useLiveQuery(() => folderPath(currentFolderId), [currentFolderId], []);
  // 検索が空のときだけ現在フォルダ直下に絞る。検索中は全フォルダ横断（従来どおり）
  const isBrowsingFolder = query.trim() === "";
  const scopedNotes = useMemo(
    () => (isBrowsingFolder ? notes.filter((n) => n.folderId === currentFolderId) : notes),
    [notes, isBrowsingFolder, currentFolderId]
  );
  const shown = useMemo(
    () => sortNotes(searchNotes(scopedNotes, query), sort),
    [scopedNotes, query, sort]
  );
  const current = view.name === "note" ? notes.find((n) => n.id === view.id) : undefined;

  // 孤児（存在しないフォルダ/親を指すメモ・フォルダ）の安全な救済。旧バージョンのクライアントが
  // folders配列を無視したままlastSyncだけ進めてしまうと、新バージョンが受け取るはずのフォルダ実体が
  // 永遠に届かず、本来は孤児ではないものまで「孤児検出→即ルートへ書き戻す」と誤修復してしまう。
  // そこで、孤児が1件でも見つかったらまず全量同期（runSync .. {full:true}）を試み、
  // それでも残った分だけ修復する。トークン未設定（オフライン単独端末）では誤修復を避けるため何もしない
  const repairOrphansSafely = useCallback(async () => {
    if (!token) return;
    const orphanCount = await countOrphans();
    if (orphanCount === 0) return;
    try {
      await runSync(token, fetch, { full: true });
    } catch {
      // 全量同期に失敗しても、既知の孤児は従来どおり救済しておく
    }
    await repairOrphans();
  }, [token]);

  const syncNow = useCallback(async () => {
    if (!token || syncing.current) return;
    syncing.current = true;
    setStatus("syncing");
    try {
      // 起動時初期化（空メモ掃除等）が終わる前に同期を始めない（初期化effectのコメント参照）
      await initCleanupRef.current;
      const result = await runSync(token);
      setFailedAttachments(result.failedAttachments);
      await repairOrphansSafely();
      // ゴミ箱行き・他端末削除・フォルダごと削除の未読をここで一括掃除する
      // （削除経路ごとの呼び漏れを同期のたびに自己修復）
      void pruneUnread().catch(() => {});
      setStatus("idle");
      setLastSync(Date.now());
    } catch {
      setStatus(navigator.onLine ? "error" : "offline");
    } finally {
      syncing.current = false;
    }
  }, [token, repairOrphansSafely]);

  const scheduleSync = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void syncNow(), 3000);
  }, [syncNow]);

  // 操作（削除・移動・並べ替え・内容変更）を1つ実行し、履歴へ積んで同期をスケジュールする共通ヘルパ。
  // 逆操作に必要な事前状態（スナップショット）はdoFn/undoFnを組み立てる呼び出し側で、操作前に控えておくこと
  const runAction = useCallback(
    async (label: string, doFn: () => Promise<void>, undoFn: () => Promise<void>) => {
      await doFn();
      setStacks((s) => pushAction(s, { label, undo: undoFn, redo: doFn }));
      scheduleSync();
    },
    [scheduleSync]
  );

  // 取り消し。対象の実体が同期・purgeで既に消えていた場合は例外を握りつぶして何もしない
  const onUndo = useCallback(async () => {
    const result = popUndo(stacks);
    if (!result) return;
    setStacks(result.stacks);
    try {
      await result.action.undo();
    } catch {
      // 実体が既に消えている等はここで握りつぶす（仕様）
    }
    scheduleSync();
  }, [stacks, scheduleSync]);

  // やり直し。取り消しと同様、対象の実体が既に消えていた場合は例外を握りつぶして何もしない
  const onRedo = useCallback(async () => {
    const result = popRedo(stacks);
    if (!result) return;
    setStacks(result.stacks);
    try {
      await result.action.redo();
    } catch {
      // 実体が既に消えている等はここで握りつぶす（仕様）
    }
    scheduleSync();
  }, [stacks, scheduleSync]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // 起動時の初期化（空メモ掃除→ゴミ箱期限purge→孤児救済)。完了PromiseをinitCleanupRefで公開し、
  // syncNowは必ずこれを待ってから走る。掃除より先に初回同期が空メモをpushすると、物理削除後の
  // エコーバック適用でdirty=0の空メモとして復活し、以後の掃除（dirty=1が条件）が二度と効かなくなるため。
  // このeffectはsyncNowを呼ぶeffect（直後）より前に宣言しておくこと（宣言順が入れ替わるとゲートが素通りになる）
  useEffect(() => {
    initCleanupRef.current = (async () => {
      await sweepEmptyNewNotes();
      await purgeExpiredTrashLocal();
      await repairOrphansSafely();
    })().catch(() => {
      // 掃除に失敗しても同期は止めない。未実行の掃除は復活レースの前提が無く、機能追加前の挙動に戻るだけ
    });
  }, []);

  useEffect(() => {
    void syncNow();
  }, [syncNow]);

  useEffect(() => {
    const onOnline = () => void syncNow();
    // タブが非表示になった瞬間はpointerup/pointercancelが届かないまま追従状態が残ることがある
    // （アプリ切替・スリープ等）。可視状態に戻ってから固まって見えないよう、hidden時に強制リセットする
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncNow();
      else resetBackSwipe();
    };
    // window blur（他アプリへのフォーカス移動等）でも同様に追従状態を強制リセットする
    const onBlur = () => resetBackSwipe();
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("blur", onBlur);
    };
  }, [syncNow, resetBackSwipe]);

  useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      if (view.name !== "list") return;
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const items = [...(e.clipboardData?.items ?? [])];
      const files = items.filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => f !== null);
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length > 0) {
        const n = await createNote("");
        for (const f of images) await addImageFromBlob(n.id, f);
        scheduleSync();
        return;
      }
      const text = e.clipboardData?.getData("text")?.trim() ?? "";
      if (text) {
        await createNote(text);
        scheduleSync();
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [view, scheduleSync]);

  // "それ以外の遷移"（進み操作）用のsetViewラッパ。navDirectionを"forward"にしてから画面を切り替える
  const goForward = useCallback((v: View) => {
    setNavDirection("forward");
    setSuppressSlideIn(false);
    setView(v);
  }, []);

  // 通知購読のヘルスチェック。起動時と、タブが可視状態に戻るたびに実行する。有効化済み（pushEnabled）
  // な端末だけが対象で、ブラウザ側で購読が失効していればensurePushSubscriptionが再購読・再登録する。
  // ただしヘルスチェックはユーザー操作起点ではないため、permissionがgranted済みの場合のみ実行する。
  // grantedでなければ（defaultやdenied）ensurePushSubscription内のrequestPermission()呼び出しに
  // 到達させず黙ってスキップする（iOSでは通知許可要求をユーザー操作起点にする必要があるため）
  // 失敗は黙認する（次回のチェックで再試行されるため、ここでエラー表示はしない）
  useEffect(() => {
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      if (await isPushEnabled()) {
        const t = localStorage.getItem("supportnote.token") ?? "";
        if (t) ensurePushSubscription(t).catch(() => {});
      }
    };
    void check();
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);

  // メモを開いたら通知の未読を解除する。一覧タップ・通知タップ・起動URLの
  // 全経路が view=note に収束するため、ここ1箇所でよい（clearUnread内でアイコンバッジも更新される）
  useEffect(() => {
    if (view.name === "note") void clearUnread(view.id).catch(() => {});
  }, [view]);

  // 起動時: 消えた・ゴミ箱行きメモの未読を掃除してバッジを実数に合わせる。
  // 復帰時: SW（別コンテキスト）が積んだ未読をアイコンバッジへ反映し直す
  useEffect(() => {
    void pruneUnread().catch(() => {});
    const onVis = () => {
      if (document.visibilityState === "visible") void syncAppBadge().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // 対象メモがローカルに存在する・かつゴミ箱でない場合だけnoteビューを開き、それ以外はlistへ
  // フォールバックする（削除済み通知の取りこぼしタップ・他端末で既に消えたメモ等への対策）
  const openNoteOrFallback = useCallback(
    (id: string) => {
      void (async () => {
        const n = await db.notes.get(id);
        if (n && n.deleted === 0) goForward({ name: "note", id });
        else goForward({ name: "list" });
      })();
    },
    [goForward]
  );

  // SW（notificationclick）からのpostMessageを受け取り、対象メモを開く。既存ウィンドウがある場合の経路
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; noteId?: string };
      if (d?.type === "open-note" && d.noteId) openNoteOrFallback(d.noteId);
    };
    navigator.serviceWorker?.addEventListener("message", onMsg);
    return () => navigator.serviceWorker?.removeEventListener("message", onMsg);
  }, [openNoteOrFallback]);

  // 起動URLの ?note=<id>（SWのopenWindowで未起動時に開かれた場合の経路）を1回だけ処理する
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("note");
    if (id) {
      history.replaceState(null, "", "/");
      openNoteOrFallback(id);
    }
  }, [openNoteOrFallback]);

  const onCreate = useCallback(async () => {
    const n = await createNote("", currentFolderId);
    // 新規だけはスライドインを再生せず即表示する（2026-07-21 オーナー要望）。スライド中は画面の
    // 左側から順に見えて「半分ずつ現れる」ように感じられるため。既存メモを開く・戻る等は従来どおり
    setNavDirection("forward");
    setSuppressSlideIn(true);
    setView({ name: "note", id: n.id, isNew: true });
  }, [currentFolderId]);

  // フォルダカードで下の階層へ入る（進み操作＝forward）
  const onOpenFolder = useCallback((id: string | null) => {
    setNavDirection("forward");
    setSuppressSlideIn(false);
    setCurrentFolderId(id);
  }, []);

  // パンくずで上位の階層へ戻る（戻り操作＝back）。折りたたみ済みの祖先idをそのまま受け取るだけなので計算不要。
  // バックスワイプ経由ではない明示操作なので、従来どおりスライドインを再生する
  const onNavigateUp = useCallback((id: string | null) => {
    setNavDirection("back");
    setSuppressSlideIn(false);
    setCurrentFolderId(id);
  }, []);

  // 「戻る」遷移先を決めて状態を更新する本体。メモ→一覧、設定→一覧、ゴミ箱→設定、一覧(フォルダ内)→親フォルダ、
  // 一覧(ルート)→何もしない。folderPathListはルート→現在フォルダの順の祖先列なので、
  // 末尾の1つ手前が親フォルダ（無ければ最上位でnull）。
  // silent=trueは完了済みバックスワイプ専用（Fix3）: ドラッグ自体が遷移の動きなので、この遷移では
  // slide-inアニメを再生しない。ボタン・パンくず経由の「戻る」はfalseで従来どおり再生する
  const performBack = useCallback(
    (silent: boolean) => {
      setNavDirection("back");
      setSuppressSlideIn(silent);
      if (view.name === "note") {
        // 未保存draftのflush→空メモ後始末の順に直列化する（flush前にdiscardIfEmptyNewが走ると、
        // 入力直後600ms以内のバックスワイプで「空と誤認→物理削除→flushがnot found」になるため）。
        // fire-and-forget: 一覧のliveQueryが削除完了時に再発火するため、遷移をawaitで遅らせない
        const isNewNote = view.isNew === true;
        const noteId = view.id;
        void (async () => {
          try {
            await noteFlushRef.current?.();
          } catch {
            // IndexedDB障害等。保存できなかった分は次の編集機会まで諦める（従来の保存押し忘れと同等）
          }
          if (!isNewNote) return;
          try {
            const r = await discardIfEmptyNew(noteId, { preferTrash: syncing.current });
            if (r === "trashed") scheduleSync();
          } catch {
            // IndexedDB障害等はここで握りつぶす（残った空メモは次回起動時の掃除で回収される）
          }
        })();
        setView({ name: "list" });
        return;
      }
      if (view.name === "settings") {
        setView({ name: "list" });
        return;
      }
      if (view.name === "trash") {
        setView({ name: "settings" });
        return;
      }
      if (view.name === "pending") {
        setView({ name: "list" });
        return;
      }
      if (view.name === "list" && currentFolderId !== null) {
        const parent = folderPathList.length >= 2 ? folderPathList[folderPathList.length - 2].id : null;
        setCurrentFolderId(parent);
      }
    },
    [view, currentFolderId, folderPathList, scheduleSync]
  );

  // ボタン・パンくず経由の「戻る」。バックスワイプの完了とは異なり、従来どおりスライドインを再生する
  const navigateBack = useCallback(() => performBack(false), [performBack]);

  // 戻り先が無い場面（一覧ルート）かどうか。navigateBackの分岐と対応させておき、falseなら追従自体を始めない
  const canGoBack = view.name !== "list" || currentFolderId !== null;

  // 背景の右フリック検出（iOS風の戻るジェスチャー）。カード・ボタン等の操作要素上のpointerdownは
  // closestで除外し、既存のスワイプ・D&D・タップ操作と干渉しないようにする。戻り先が無い場面でも始めない
  const onMainPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      if (
        !canGoBack ||
        target.closest(".card, .swipe-wrap, button, a, input, textarea, select, .breadcrumb, .overlay, .gallery, img")
      ) {
        backSwipeStart.current = null;
        return;
      }
      backSwipeStart.current = { x: e.clientX, y: e.clientY, t: Date.now() };
      followingBack.current = false;
      dragScreenEl.current = null;
    },
    [canGoBack]
  );

  // 右方向のドラッグ（dx>10・|dx|>|dy|）が始まったら、現在の.screenを指に追従させる（transform: translateX(dx)、dx≥0のみ）。
  // 縦優勢（|dy|>|dx|）になったら追従を中止して0に戻し、このジェスチャーは終える（縦スクロールに譲る）
  const onMainPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const start = backSwipeStart.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    if (!followingBack.current) {
      if (!(dx > 10 && Math.abs(dx) > Math.abs(dy))) return;
      followingBack.current = true;
      setIsFollowingBack(true);
      dragScreenEl.current = mainRef.current?.querySelector<HTMLElement>(".screen") ?? null;
      const el = dragScreenEl.current;
      if (el) el.style.transition = "none";
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // 一部環境でcaptureできなくても追従自体は継続する
      }
    }

    if (Math.abs(dy) > Math.abs(dx)) {
      resetBackSwipe();
      return;
    }

    // pointerupを取り逃した場合の保険（2秒間pointermoveが無ければ強制リセット）。
    // 動きが続く限り再武装するだけなので、正常に長く追従している最中は発火しない
    window.clearTimeout(backSwipeWatchdog.current);
    backSwipeWatchdog.current = window.setTimeout(resetBackSwipe, 2000);

    const el = dragScreenEl.current;
    if (el) el.style.transform = `translateX(${Math.max(0, dx)}px)`;
  }, [resetBackSwipe]);

  const onMainPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const start = backSwipeStart.current;
      const wasFollowing = followingBack.current;
      if (!start || !wasFollowing) {
        resetBackSwipe();
        return;
      }
      const dx = e.clientX - start.x;
      const vx = dx / Math.max(1, Date.now() - start.t);
      const complete = shouldCompleteBack(dx, vx);
      if (complete) {
        // 完了: ドラッグ自体が遷移の動きなので、150msの巻き戻しもslide-inの再生もしない（Fix3）
        completeBackSwipe();
        performBack(true);
      } else {
        // キャンセル（しきい値未満）: 従来どおり150msで0へ戻す
        resetBackSwipe();
      }
    },
    [completeBackSwipe, performBack, resetBackSwipe]
  );

  // pointercancel（中断）でも追従中なら0へ戻し、状態を片付ける
  const onMainPointerCancel = useCallback(() => {
    resetBackSwipe();
  }, [resetBackSwipe]);

  // 追従中（followingBack）は縦スクロールを起こさない。既存のD&D（NoteList側）と同じく、
  // 非passiveのtouchmoveでpreventDefaultする以外に手段が無いため、ここだけネイティブイベントを使う
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    function onTouchMove(ev: TouchEvent) {
      if (followingBack.current) ev.preventDefault();
    }
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  }, []);

  // 追従スワイプ中にmain要素自身がpointerup/pointercancelを受け取れないことがある（NoteList側のD&D
  // フォールバックと同じ理由: setPointerCaptureが効かない環境で、指が離れた場所によっては届かない）。
  // documentにもフォールバックを張り、確実に追従状態を終わらせる。追従開始時（isFollowingBack=true）
  // に張り、終了時（false・アンマウント）に必ず外す
  useEffect(() => {
    if (!isFollowingBack) return;
    function finish() {
      if (!followingBack.current) return;
      resetBackSwipe();
    }
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    return () => {
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
    };
  }, [isFollowingBack, resetBackSwipe]);

  const onCreateFolder = useCallback(async () => {
    const name = prompt("新しいフォルダ名");
    if (!name || !name.trim()) return;
    await createFolder(name.trim(), currentFolderId);
    scheduleSync();
  }, [currentFolderId, scheduleSync]);

  const onRenameCurrentFolder = useCallback(async () => {
    const cur = folderPathList[folderPathList.length - 1];
    if (!cur) return;
    const name = prompt("フォルダ名", cur.name);
    if (!name || !name.trim()) return;
    await renameFolder(cur.id, name.trim());
    scheduleSync();
  }, [folderPathList, scheduleSync]);

  const onDeleteFolder = useCallback(
    (id: string) => {
      void runAction(
        "フォルダを削除",
        async () => {
          await deleteFolderWithContents(id);
        },
        async () => {
          await restoreFolderWithContents(id);
        }
      );
    },
    [runAction]
  );

  const onRestoreNoteFromTrash = useCallback(
    (id: string) => {
      void runAction(
        "メモを復元",
        async () => {
          await restoreNote(id);
        },
        async () => {
          await softDeleteNote(id);
        }
      );
    },
    [runAction]
  );

  const onRestoreFolderFromTrash = useCallback(
    (id: string) => {
      void runAction(
        "フォルダを復元",
        async () => {
          await restoreFolderWithContents(id);
        },
        async () => {
          await deleteFolderWithContents(id);
        }
      );
    },
    [runAction]
  );

  // メモ移動（D&D・移動ピッカー共通）。移動前のfolderIdを控えておき、undoで戻す
  const onMoveNote = useCallback(
    (noteId: string, folderId: string | null) => {
      const before = notes.find((n) => n.id === noteId)?.folderId ?? null;
      void runAction(
        "メモを移動",
        async () => {
          await moveNote(noteId, folderId);
        },
        async () => {
          await moveNote(noteId, before);
        }
      );
    },
    [notes, runAction]
  );

  // 自動保存（NoteScreen）。インラインだと毎レンダーで参照が変わり、NoteScreen側のデバウンスeffect
  // （依存にonAutoSaveを含む）が編集中の無関係な再レンダーのたびにタイマーをリセットしてしまうため、
  // メモ表示中はviewが同一参照で安定することを利用してuseCallbackで固定する
  const onAutoSaveNote = useCallback(
    async (body: string) => {
      if (view.name !== "note") return;
      await updateNote(view.id, { body });
      scheduleSync();
    },
    [view, scheduleSync]
  );

  // フォルダ移動（D&D）。moveFolderがfalse（自分自身への移動・子孫への移動など無効な操作）を返した場合は
  // 何も起きていないので履歴に積まない・同期もしない（falseになるケースは握りつぶしてよい仕様）
  const onMoveFolder = useCallback(
    (id: string, parentId: string | null) => {
      void (async () => {
        const cur = await db.folders.get(id);
        const before = cur?.parentId ?? null;
        const moved = await moveFolder(id, parentId);
        if (!moved) return;
        setStacks((s) =>
          pushAction(s, {
            label: "フォルダを移動",
            undo: async () => {
              await moveFolder(id, before);
            },
            redo: async () => {
              await moveFolder(id, parentId);
            },
          })
        );
        scheduleSync();
      })();
    },
    [scheduleSync]
  );

  const onReorderNote = useCallback(
    (plan: ReorderPlan<{ id: string; orderKey: number | null }>) => {
      // 適用前のorderKeyを控える（normalized適用がある場合は対象全件、無ければドラッグ対象のみ）
      const beforeOf = (id: string) => notes.find((n) => n.id === id)?.orderKey ?? null;
      const beforeNormalized = plan.normalized?.map((item) => ({ id: item.id, orderKey: beforeOf(item.id) }));
      const beforeTarget = beforeOf(plan.targetId);
      void runAction(
        "メモの並べ替え",
        async () => {
          if (plan.normalized) {
            for (const item of plan.normalized) await reorderNote(item.id, item.orderKey as number);
          }
          await reorderNote(plan.targetId, plan.targetOrderKey);
          // 手動で並べ替えたら、現在のソートがmanualでなければ自動で切り替える（手動順が見える状態にする）
          if (sort !== "manual") setSort("manual");
        },
        async () => {
          // 元のorderKeyへ一括書き戻す（nullだった場合もあるため、number限定のreorderNoteでなくupdateNoteを使う）
          if (beforeNormalized) {
            for (const item of beforeNormalized) await updateNote(item.id, { orderKey: item.orderKey });
          }
          await updateNote(plan.targetId, { orderKey: beforeTarget });
        }
      );
    },
    [notes, sort, runAction]
  );

  // フォルダの並べ替えはソートモードに関係なく常に有効
  const onReorderFolder = useCallback(
    (plan: ReorderPlan<{ id: string; orderKey: number | null }>) => {
      const beforeOf = (id: string) => childFolders.find((f) => f.id === id)?.orderKey ?? null;
      const beforeNormalized = plan.normalized?.map((item) => ({ id: item.id, orderKey: beforeOf(item.id) }));
      const beforeTarget = beforeOf(plan.targetId);
      void runAction(
        "フォルダの並べ替え",
        async () => {
          if (plan.normalized) {
            for (const item of plan.normalized) await reorderFolder(item.id, item.orderKey as number);
          }
          await reorderFolder(plan.targetId, plan.targetOrderKey);
        },
        async () => {
          if (beforeNormalized) {
            for (const item of beforeNormalized) await updateFolder(item.id, { orderKey: item.orderKey });
          }
          await updateFolder(plan.targetId, { orderKey: beforeTarget });
        }
      );
    },
    [childFolders, runAction]
  );

  // 同期バー。一覧・メモ・設定・ゴミ箱それぞれのヘッダー（.list-header）内にまとめて表示するため、
  // 要素として一度だけ組み立てて各画面へ渡す（画面ごとに個別にposition:stickyを重ねると二重に固定されてしまうため）
  const syncBar = (
    <SyncStatus
      status={status}
      pending={pending}
      lastSync={lastSync}
      failedAttachments={failedAttachments}
      canUndo={stacks.past.length > 0}
      canRedo={stacks.future.length > 0}
      onUndo={() => void onUndo()}
      onRedo={() => void onRedo()}
      onSync={() => void syncNow()}
      onSettings={() => goForward({ name: "settings" })}
    />
  );

  // navDirectionに応じたスライドイン方向のクラス（戻り=左から、進み=右から）。
  // バックスワイプ完了時（suppressSlideIn）はドラッグ自体が遷移の動きなので、このクラスは付けない（Fix3）
  const slideClass = suppressSlideIn ? "" : navDirection === "back" ? "slide-in-left" : "slide-in-right";

  // 名前未設定の端末は、通常UIより先に全画面のNameGateだけを描画する。保存後はonDoneでローカルstateを
  // 更新し、以降のcreateNote呼び出しがgetUserName()経由で設定済みの名前をauthorに使えるようにする
  if (!userName) {
    return <NameGate onDone={() => setUserNameState(getUserName())} />;
  }

  return (
    <main
      className="app"
      ref={mainRef}
      onPointerDown={onMainPointerDown}
      onPointerMove={onMainPointerMove}
      onPointerUp={onMainPointerUp}
      onPointerCancel={onMainPointerCancel}
    >
      {/* 画面切替（list/note/settings/trash）は各画面自身のルート要素(.screen)にslideClassを直接付ける。
          view.nameで排他的に切り替わるため、これだけで乗り換え時に毎回フルマウントされスライドアニメが動く */}
      {view.name === "list" && (
        <NoteList
          syncBar={syncBar}
          slideClass={slideClass}
          notes={shown}
          sort={sort}
          onSort={setSort}
          query={query}
          onQuery={setQuery}
          onOpen={(id) => goForward({ name: "note", id })}
          onCreate={onCreate}
          onDelete={(id) => {
            void runAction(
              "メモを削除",
              async () => {
                await softDeleteNote(id);
              },
              async () => {
                await restoreNote(id);
              }
            );
          }}
          isBrowsingFolder={isBrowsingFolder}
          currentFolderId={currentFolderId}
          folderPath={folderPathList}
          childFolders={childFolders}
          onOpenFolder={onOpenFolder}
          onNavigateUp={onNavigateUp}
          onBack={navigateBack}
          onCreateFolder={onCreateFolder}
          onRenameCurrentFolder={onRenameCurrentFolder}
          onDeleteFolder={onDeleteFolder}
          onMoveNote={onMoveNote}
          onMoveFolder={onMoveFolder}
          onReorderNote={onReorderNote}
          onReorderFolder={onReorderFolder}
          onOpenPending={() => goForward({ name: "pending" })}
        />
      )}
      {view.name === "note" && current && (
        <NoteScreen
          syncBar={syncBar}
          slideClass={slideClass}
          note={current}
          startEditing={view.name === "note" && view.isNew === true}
          onChange={(patch) => {
            // 逆操作に必要な旧値は、変更対象のフィールドだけをcurrentからスナップショットする
            const before: NotePatch = {};
            if ("body" in patch) before.body = current.body;
            if ("importance" in patch) before.importance = current.importance;
            if ("answered" in patch) before.answered = current.answered;
            void runAction(
              labelForNotePatch(patch),
              async () => {
                await updateNote(current.id, patch as NotePatch);
              },
              async () => {
                await updateNote(current.id, before);
              }
            );
          }}
          onDelete={() => {
            void runAction(
              "メモを削除",
              async () => {
                await softDeleteNote(current.id);
              },
              async () => {
                await restoreNote(current.id);
              }
            ).then(() => goForward({ name: "list" }));
          }}
          onBack={navigateBack}
          onMoveNote={onMoveNote}
          onAttached={() => scheduleSync()}
          onDeleteAttachment={(attId) => {
            void runAction(
              "画像を削除",
              async () => {
                await softDeleteAttachment(attId);
              },
              async () => {
                await restoreAttachment(attId);
              }
            );
          }}
          // 検索から開いたメモだけハイライトする。検索中に「新規」で作ったメモに古い検索語のマークが付かないようisNewでは渡さない
          highlightQuery={view.isNew ? "" : query}
          onAutoSave={onAutoSaveNote}
          onEditSessionEnd={(before, after) => {
            // 自動保存は積まず、編集セッション1回分をundo1エントリにまとめる。
            // DB書き込みは自動保存で済んでいるため、pushActionを直接使う（runActionのdoFnは実行しない）
            setStacks((s) =>
              pushAction(s, {
                label: "本文を変更",
                undo: async () => {
                  await updateNote(current.id, { body: before });
                },
                redo: async () => {
                  await updateNote(current.id, { body: after });
                },
              })
            );
          }}
          flushRef={noteFlushRef}
        />
      )}
      {view.name === "settings" && (
        <Settings
          syncBar={syncBar}
          slideClass={slideClass}
          token={token}
          onSave={(t) => {
            void saveToken(t).then((ok) => {
              if (!ok) alert("トークンを端末に保存できませんでした。次回起動時は再入力が必要です");
            });
            setToken(t);
            goForward({ name: "list" });
          }}
          onBack={navigateBack}
          onExport={async () => {
            const { blob, missingImages } = await exportZip(token);
            if (missingImages > 0) {
              alert(`未取得の画像 ${missingImages}件はこの端末に無いため含まれていません`);
            }
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `サポートノート-エクスポート-${localYmd(new Date())}.zip`;
            a.click();
            URL.revokeObjectURL(a.href);
          }}
          onTrash={() => goForward({ name: "trash" })}
        />
      )}
      {view.name === "trash" && (
        <TrashScreen
          syncBar={syncBar}
          slideClass={slideClass}
          onBack={navigateBack}
          onRestoreNote={onRestoreNoteFromTrash}
          onRestoreFolder={onRestoreFolderFromTrash}
        />
      )}
      {view.name === "pending" && (
        <PendingScreen
          syncBar={syncBar}
          slideClass={slideClass}
          onBack={navigateBack}
          // 一覧タップと同じ関数（対象は未対応メモの一覧から取得済みで存在が保証されるため、フォールバック判定は不要）
          onOpenNote={(id) => goForward({ name: "note", id })}
        />
      )}
    </main>
  );
}
