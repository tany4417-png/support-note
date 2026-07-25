import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "./db";
import { getClientId } from "./client-id";

beforeEach(async () => {
  await resetDbForTests();
});

describe("getClientId", () => {
  it("初回は生成して保存し、2回目は同じ値を返す", async () => {
    const first = await getClientId();
    expect(first.length).toBeGreaterThan(0);
    expect(await getClientId()).toBe(first);
  });

  it("端末ごとに異なる（DBを作り直すと別の値になる）", async () => {
    const first = await getClientId();
    await resetDbForTests();
    expect(await getClientId()).not.toBe(first);
  });
});
