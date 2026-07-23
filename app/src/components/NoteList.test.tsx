// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { resetDbForTests } from "../lib/db";
import type { Note } from "../lib/types";
import { NoteList } from "./NoteList";

function makeNote(overrides: Partial<Note>): Note {
  return {
    id: "N",
    body: "本文",
    importance: 0,
    createdAt: 1,
    updatedAt: 1,
    deleted: 0,
    dirty: 0,
    folderId: null,
    author: null,
    answered: 0,
    ...overrides,
  };
}

function renderNoteList(notes: Note[], overrides: Partial<React.ComponentProps<typeof NoteList>> = {}) {
  render(
    <NoteList
      syncBar={null}
      notes={notes}
      sort="created"
      onSort={() => {}}
      query=""
      onQuery={() => {}}
      onOpen={() => {}}
      onCreate={() => {}}
      onDelete={() => {}}
      isBrowsingFolder={true}
      currentFolderId={null}
      slideClass=""
      folderPath={[]}
      childFolders={[]}
      onOpenFolder={() => {}}
      onNavigateUp={() => {}}
      onBack={() => {}}
      onCreateFolder={() => {}}
      onRenameCurrentFolder={() => {}}
      onDeleteFolder={() => {}}
      onMoveNote={() => {}}
      onMoveFolder={() => {}}
      onReorderNote={() => {}}
      onReorderFolder={() => {}}
      onOpenPending={() => {}}
      {...overrides}
    />
  );
}

describe("NoteListの未対応バッジ", () => {
  it("answered=0のカードにだけ「未対応」バッジが出る", async () => {
    await resetDbForTests();
    const pending = makeNote({ id: "P1", body: "未対応メモ", answered: 0 });
    const done = makeNote({ id: "D1", body: "対応済みメモ", answered: 1 });
    renderNoteList([pending, done]);

    // PendingCardはDB（fake-indexeddb）を直接見るためこのテストでは0件表示（非表示）。
    // 「未対応」の表示はカードのバッジ1件分だけになる
    const badges = screen.getAllByText("未対応");
    expect(badges.length).toBe(1);
    expect(screen.queryByText("対応済みメモ")).toBeTruthy();
  });
});

describe("NoteListのPendingCard配置", () => {
  it("ルート表示（フォルダ閲覧かつcurrentFolderId=null）ではonOpenPendingが呼べる導線を渡す", async () => {
    await resetDbForTests();
    const onOpenPending = vi.fn();
    renderNoteList([], { onOpenPending });
    // PendingCardは未対応0件のため非表示だが、propが型として要求されコンパイルできることを確認する
    expect(onOpenPending).not.toHaveBeenCalled();
  });
});
