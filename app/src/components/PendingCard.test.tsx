// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db, resetDbForTests } from "../lib/db";
import { createNote, updateNote } from "../lib/notes";
import { PendingCard } from "./PendingCard";

beforeEach(async () => {
  await resetDbForTests();
});

describe("PendingCard", () => {
  it("未対応メモが0件なら何も表示しない", async () => {
    await createNote("最初から対応済み").then((n) => updateNote(n.id, { answered: 1 }));
    render(<PendingCard onOpen={() => {}} />);
    // useLiveQueryの初回解決を待ってから「出ていないこと」を確認する
    await waitFor(async () => expect(await db.notes.count()).toBe(1));
    expect(screen.queryByText("未対応")).toBeNull();
  });

  it("未対応（deleted=0かつanswered=0）の件数を表示する", async () => {
    await createNote("未対応1");
    await createNote("未対応2");
    const done = await createNote("対応済み");
    await updateNote(done.id, { answered: 1 });
    const trashed = await createNote("ゴミ箱行き");
    await updateNote(trashed.id, { deleted: 1 });

    render(<PendingCard onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText("未対応")).toBeTruthy());
    expect(screen.getByText("2件")).toBeTruthy();
  });

  it("作成が古い順にタイトル最大3件を表示し、4件目以降は「ほかN件」にまとめる", async () => {
    const n1 = await createNote("1件目\n本文");
    await new Promise((r) => setTimeout(r, 5));
    await createNote("2件目");
    await new Promise((r) => setTimeout(r, 5));
    await createNote("3件目");
    await new Promise((r) => setTimeout(r, 5));
    await createNote("4件目");

    render(<PendingCard onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText("4件")).toBeTruthy());
    expect(screen.getByText("1件目")).toBeTruthy();
    expect(screen.getByText("2件目")).toBeTruthy();
    expect(screen.getByText("3件目")).toBeTruthy();
    expect(screen.getByText("ほか1件")).toBeTruthy();
    expect(screen.queryByText("4件目")).toBeNull();
    void n1;
  });

  it("3件以下なら「ほか」は出ない", async () => {
    await createNote("A");
    await createNote("B");
    render(<PendingCard onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText("2件")).toBeTruthy());
    expect(screen.queryByText(/^ほか/)).toBeNull();
  });

  it("カード全体タップでonOpenが呼ばれる", async () => {
    await createNote("未対応メモ");
    const onOpen = vi.fn();
    render(<PendingCard onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText("未対応")).toBeTruthy());
    fireEvent.click(screen.getByText("未対応"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
