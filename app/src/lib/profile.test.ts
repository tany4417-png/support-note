// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getUserName, setUserName } from "./profile";

const NAME_KEY = "supportnote.name";

beforeEach(() => {
  localStorage.clear();
});

describe("getUserName", () => {
  it("未設定はnull", () => {
    expect(getUserName()).toBeNull();
  });

  it("設定済みならlocalStorageの値を返す", () => {
    localStorage.setItem(NAME_KEY, "山田");
    expect(getUserName()).toBe("山田");
  });
});

describe("setUserName", () => {
  it("localStorageに保存する", () => {
    setUserName("山田");
    expect(localStorage.getItem(NAME_KEY)).toBe("山田");
    expect(getUserName()).toBe("山田");
  });

  it("上書きできる", () => {
    setUserName("旧名前");
    setUserName("新名前");
    expect(getUserName()).toBe("新名前");
  });
});
