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
    localStorage.setItem(NAME_KEY, "大谷");
    expect(getUserName()).toBe("大谷");
  });
});

describe("setUserName", () => {
  it("localStorageに保存する", () => {
    setUserName("大谷");
    expect(localStorage.getItem(NAME_KEY)).toBe("大谷");
    expect(getUserName()).toBe("大谷");
  });

  it("上書きできる", () => {
    setUserName("旧名前");
    setUserName("新名前");
    expect(getUserName()).toBe("新名前");
  });
});
