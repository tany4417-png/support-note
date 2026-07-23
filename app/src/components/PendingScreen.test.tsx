// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetDbForTests } from "../lib/db";
import { createNote, updateNote } from "../lib/notes";
import { PendingScreen } from "./PendingScreen";

beforeEach(async () => {
  await resetDbForTests();
});

describe("PendingScreen", () => {
  it("見出し「未対応」と戻るボタンを表示する", () => {
    render(<PendingScreen slideClass="" syncBar={null} onBack={() => {}} onOpenNote={() => {}} />);
    expect(screen.getByText("未対応")).toBeTruthy();
    expect(screen.getByRole("button", { name: "戻る" })).toBeTruthy();
  });

  it("戻るボタンでonBackが呼ばれる", () => {
    const onBack = vi.fn();
    render(<PendingScreen slideClass="" syncBar={null} onBack={onBack} onOpenNote={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("未対応メモが無ければ空状態メッセージを表示する", async () => {
    render(<PendingScreen slideClass="" syncBar={null} onBack={() => {}} onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByText("未対応のメモはありません")).toBeTruthy());
  });

  it("未対応メモを作成が古い順に列挙し、対応済み・ゴミ箱行きは含めない", async () => {
    await createNote("古いメモ");
    await new Promise((r) => setTimeout(r, 5));
    await createNote("新しいメモ");
    const done = await createNote("対応済み");
    await updateNote(done.id, { answered: 1 });
    const trashed = await createNote("ゴミ箱行き");
    await updateNote(trashed.id, { deleted: 1 });

    render(<PendingScreen slideClass="" syncBar={null} onBack={() => {}} onOpenNote={() => {}} />);
    await waitFor(() => expect(screen.getByText("古いメモ")).toBeTruthy());
    expect(screen.getByText("新しいメモ")).toBeTruthy();
    expect(screen.queryByText("対応済み")).toBeNull();
    expect(screen.queryByText("ゴミ箱行き")).toBeNull();

    const titles = screen.getAllByText(/メモ$/).map((el) => el.textContent);
    expect(titles).toEqual(["古いメモ", "新しいメモ"]);
  });

  it("行タップでonOpenNoteが対象idで呼ばれる", async () => {
    const n = await createNote("タップ対象");
    const onOpenNote = vi.fn();
    render(<PendingScreen slideClass="" syncBar={null} onBack={() => {}} onOpenNote={onOpenNote} />);
    await waitFor(() => expect(screen.getByText("タップ対象")).toBeTruthy());
    fireEvent.click(screen.getByText("タップ対象"));
    expect(onOpenNote).toHaveBeenCalledWith(n.id);
  });
});
