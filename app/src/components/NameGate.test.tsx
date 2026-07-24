// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { getUserName } from "../lib/profile";
import { NameGate } from "./NameGate";

beforeEach(() => {
  localStorage.clear();
});

describe("NameGate", () => {
  it("タイトル・説明・入力欄・保存ボタンを表示する", () => {
    render(<NameGate onDone={() => {}} />);
    expect(screen.getByText("サポートノート")).toBeTruthy();
    expect(screen.getByText("メモに表示する名前を入力してください")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
  });

  it("名前を入力して保存すると保存され、onDoneが呼ばれる", () => {
    const onDone = vi.fn();
    render(<NameGate onDone={onDone} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "山田" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(getUserName()).toBe("山田");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("前後の空白はtrimして保存される", () => {
    const onDone = vi.fn();
    render(<NameGate onDone={onDone} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  山田  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(getUserName()).toBe("山田");
  });

  it("空白のみの入力は保存できない（onDoneも呼ばれない）", () => {
    const onDone = vi.fn();
    render(<NameGate onDone={onDone} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(getUserName()).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("未入力のまま保存を押しても何も起きない", () => {
    const onDone = vi.fn();
    render(<NameGate onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(getUserName()).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("Enterキーでも保存できる", () => {
    const onDone = vi.fn();
    render(<NameGate onDone={onDone} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "山田" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(getUserName()).toBe("山田");
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
