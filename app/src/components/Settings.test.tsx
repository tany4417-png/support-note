// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Settings } from "./Settings";

// pushはservice worker/通知APIに触れるためモックする（この画面のコピー機能とは無関係）
vi.mock("../lib/push", () => ({
  isPushEnabled: () => Promise.resolve(false),
  ensurePushSubscription: vi.fn(),
  disablePush: vi.fn(),
  sendTestPush: vi.fn(),
}));

const baseProps = {
  syncBar: null,
  slideClass: "",
  token: "tok-abc-123456",
  onSave: () => {},
  onBack: () => {},
  onExport: () => {},
  onTrash: () => {},
};

beforeEach(() => {
  localStorage.clear();
});

describe("Settings トークンをコピー", () => {
  it("ボタンを押すとトークンがクリップボードにコピーされる", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Settings {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "トークンをコピー" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("tok-abc-123456"));
  });

  it("トークンが空のときはコピーボタンを出さない", () => {
    render(<Settings {...baseProps} token="" />);
    expect(screen.queryByRole("button", { name: "トークンをコピー" })).toBeNull();
  });
});
