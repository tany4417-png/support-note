// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Note } from "../lib/types";
import { NoteScreen } from "./NoteScreen";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "N1",
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

function renderNoteScreen(note: Note, onChange = vi.fn()) {
  render(
    <NoteScreen
      syncBar={null}
      slideClass=""
      note={note}
      onChange={onChange}
      onDelete={() => {}}
      onBack={() => {}}
      onMoveNote={() => {}}
      onDeleteAttachment={() => {}}
      onAutoSave={async () => {}}
      onEditSessionEnd={() => {}}
      flushRef={{ current: null }}
    />
  );
  return onChange;
}

describe("NoteScreenの対応ステータストグル", () => {
  it("未対応（answered=0）は「対応済みにする」ボタンを表示する", () => {
    renderNoteScreen(makeNote({ answered: 0 }));
    expect(screen.getByRole("button", { name: "対応済みにする" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "未対応に戻す" })).toBeNull();
  });

  it("対応済み（answered=1）は「未対応に戻す」ボタンを表示する", () => {
    renderNoteScreen(makeNote({ answered: 1 }));
    expect(screen.getByRole("button", { name: "未対応に戻す" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "対応済みにする" })).toBeNull();
  });

  it("「対応済みにする」を押すとonChangeが{answered:1}で呼ばれる", () => {
    const onChange = renderNoteScreen(makeNote({ answered: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "対応済みにする" }));
    expect(onChange).toHaveBeenCalledWith({ answered: 1 });
  });

  it("「未対応に戻す」を押すとonChangeが{answered:0}で呼ばれる", () => {
    const onChange = renderNoteScreen(makeNote({ answered: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "未対応に戻す" }));
    expect(onChange).toHaveBeenCalledWith({ answered: 0 });
  });
});
