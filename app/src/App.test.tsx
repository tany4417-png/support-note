// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { resetDbForTests } from "./lib/db";
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
