// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db, resetDbForTests } from "./lib/db";
import { setUserName } from "./lib/profile";
import App from "./App";

// 対象メモがローカルにまだpullされていない（=通知タップ時点でまだ同期していない）状況を再現するid
const TARGET_NOTE_ID = "note-not-pulled-yet";

function syncResponseBody(includeTarget: boolean) {
  const now = Date.now();
  return JSON.stringify({
    now,
    notes: includeTarget
      ? [
          {
            id: TARGET_NOTE_ID,
            body: "新着メモ本文",
            importance: 0,
            createdAt: now,
            updatedAt: now,
            deleted: 0,
            folderId: null,
            orderKey: null,
            author: "山田",
            answered: 0,
          },
        ]
      : [],
    attachments: [],
    folders: [],
  });
}

describe("App openNoteOrFallback（通知タップ経路）", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let swContainer: EventTarget;
  let includeTarget: boolean;

  beforeEach(async () => {
    await resetDbForTests();
    localStorage.clear();
    setUserName("山田");
    localStorage.setItem("supportnote.token", "test-token");

    includeTarget = false;
    fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.startsWith("/api/sync")) {
        return new Response(syncResponseBody(includeTarget));
      }
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);

    // jsdomはnavigator.serviceWorkerを実装していないため、SWのpostMessage経路をテストできるよう
    // 最低限のEventTargetを差し込む（App.tsxはnavigator.serviceWorker?.addEventListener("message", ...)で受ける）
    swContainer = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", { value: swContainer, configurable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("未pullのメモへの通知タップは、一度同期してから開く（一覧への空振りフォールバックをしない）", async () => {
    render(<App />);

    // 起動時の自動同期（1回目）が完了するのを待つ（SyncStatusの「同期済み」状態＝.dot.idle）
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector(".dot.idle")).not.toBeNull());

    // 通知タップの時点でサーバーに新着メモが用意された（＝この端末はまだpullしていない）想定
    includeTarget = true;
    swContainer.dispatchEvent(
      new MessageEvent("message", { data: { type: "open-note", noteId: TARGET_NOTE_ID } })
    );

    await waitFor(() => expect(document.querySelector(".note.screen")).not.toBeNull());
    expect(screen.getByText("新着メモ本文")).toBeTruthy();
  });
});

describe("App ?note=URL経由の冷起動（マウント時自動同期との競合）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, "", "/");
  });

  // SWのopenWindow('/?note=<id>')で未起動から起動する冷起動経路では、マウント時の自動同期effect（255行付近）が
  // ?note=処理effect（377行付近）より先に走る。openNoteOrFallback内のawait syncNow()が、進行中の本物の同期を
  // 待たずに空振りしていないかを検証する。fetchを手動resolveのdeferred Promiseにして「同期が完了する前」の
  // 状態を確定的に作り、その間はまだメモ画面へ遷移していないこと・resolve後に遷移することの両方を確認する
  it("同期進行中に?note=で起動しても、同期完了を待ってからそのメモを開く（空振りフォールバックしない）", async () => {
    await resetDbForTests();
    localStorage.clear();
    setUserName("山田");
    localStorage.setItem("supportnote.token", "test-token");

    let resolveSync: ((r: Response) => void) | undefined;
    const deferredSync = new Promise<Response>((resolve) => {
      resolveSync = resolve;
    });
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.startsWith("/api/sync")) return deferredSync;
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);

    // サーバーは起動時点で既にターゲットメモを持っている（他端末が投稿済み・この端末はまだ未pull）
    history.replaceState(null, "", `/?note=${TARGET_NOTE_ID}`);

    render(<App />);

    // マウント時自動同期のfetchが呼ばれた（＝同期が進行中）。ここではまだ解決させない
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 同期が完了する前に、空振りして一覧のまま止まっていないか（まだメモ画面へは遷移していないはず）
    expect(document.querySelector(".note.screen")).toBeNull();

    // ここで初めてマウント時の同期を完了させる
    resolveSync!(new Response(syncResponseBody(true)));

    await waitFor(() => expect(document.querySelector(".note.screen")).not.toBeNull());
    expect(screen.getByText("新着メモ本文")).toBeTruthy();
  });
});

describe("編集中メモIDの申告と、閉じたときの同期", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await resetDbForTests();
    localStorage.clear();
    setUserName("山田");
    localStorage.setItem("supportnote.token", "test-token");
    fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).startsWith("/api/sync")) return new Response(syncResponseBody(false));
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function syncBodies() {
    return fetchMock.mock.calls
      .filter((c) => String(c[0]).startsWith("/api/sync"))
      .map((c) => JSON.parse((c[1] as RequestInit).body as string));
  }

  it("メモ画面を開いている間の同期には editingNoteId が載り、閉じた直後の同期では null になる", async () => {
    render(<App />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "新規" }));
    await waitFor(() => expect(document.querySelector(".note.screen")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "戻る" }));

    await waitFor(() => {
      const bodies = syncBodies();
      expect(bodies.length).toBeGreaterThan(1);
      expect(bodies[bodies.length - 1].editingNoteId).toBeNull();
    });
  });

  it("空の新規メモを開いて閉じても、ゴミ箱に残らず物理削除される", async () => {
    render(<App />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "新規" }));
    await waitFor(() => expect(document.querySelector(".note.screen")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));

    await waitFor(async () => {
      expect(await db.notes.count()).toBe(0);
    });
  });
});

describe("syncNowの末尾実行", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await resetDbForTests();
    localStorage.clear();
    setUserName("山田");
    localStorage.setItem("supportnote.token", "test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("同期の進行中に呼ばれたら、完了後にもう一度走る", async () => {
    let resolveFirst: ((r: Response) => void) | null = null;
    let syncCalls = 0;
    fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (!String(url).startsWith("/api/sync")) return new Response("{}");
      syncCalls += 1;
      if (syncCalls === 1) return new Promise<Response>((r) => { resolveFirst = r; });
      return new Response(syncResponseBody(false));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => expect(syncCalls).toBe(1));

    // 1回目が飛んでいる間にメモを作って閉じる（＝閉じたときのsyncNowが進行中に当たる）
    fireEvent.click(screen.getByRole("button", { name: "新規" }));
    await waitFor(() => expect(document.querySelector(".note.screen")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));

    // 進行中のリクエストには「閉じた」ことが乗らないので、完了後にもう一度走る必要がある
    await waitFor(() => expect(resolveFirst).not.toBeNull());
    resolveFirst!(new Response(syncResponseBody(false)));

    await waitFor(() => expect(syncCalls).toBeGreaterThan(1));
  });
});

describe("hidden側の同期", () => {
  beforeEach(async () => {
    await resetDbForTests();
    localStorage.clear();
    setUserName("山田");
    localStorage.setItem("supportnote.token", "test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("アプリが背面に回ったときも同期し、editingNoteIdはnullで送る", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).startsWith("/api/sync")) return new Response(syncResponseBody(false));
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "新規" }));
    await waitFor(() => expect(document.querySelector(".note.screen")).not.toBeNull());

    const callsBefore = fetchMock.mock.calls.length;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
    const last = JSON.parse((fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as RequestInit).body as string);
    expect(last.editingNoteId).toBeNull();

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
});
