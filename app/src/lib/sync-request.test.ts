// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDbForTests } from "./db";
import { setUserName } from "./profile";
import { runSync, setEditingNoteIdRef } from "./sync";

function okResponse() {
  return new Response(JSON.stringify({ now: 1, notes: [], attachments: [], folders: [], purgedIds: [] }));
}

function bodyOf(mock: ReturnType<typeof vi.fn>, callIndex = 0) {
  return JSON.parse(mock.mock.calls[callIndex][1].body as string);
}

beforeEach(async () => {
  await resetDbForTests();
  localStorage.clear();
  setUserName("山田");
  setEditingNoteIdRef(() => null);
});

describe("runSyncのリクエスト", () => {
  it("端末IDと名前を載せる", async () => {
    const f = vi.fn(async () => okResponse());
    await runSync("t", f as unknown as typeof fetch);
    const body = bodyOf(f);
    expect(typeof body.clientId).toBe("string");
    expect(body.clientId.length).toBeGreaterThan(0);
    expect(body.actorName).toBe("山田");
  });

  it("編集中のメモIDを載せる", async () => {
    setEditingNoteIdRef(() => "note-1");
    const f = vi.fn(async () => okResponse());
    await runSync("t", f as unknown as typeof fetch);
    expect(bodyOf(f).editingNoteId).toBe("note-1");
  });

  it("suppressNotifyは呼び出し側が指定したときだけ真になる", async () => {
    const f = vi.fn(async () => okResponse());
    await runSync("t", f as unknown as typeof fetch);
    expect(bodyOf(f).suppressNotify).toBe(false);
  });

  it("孤児救済の全量押し直しではsuppressNotifyが真になる", async () => {
    const f = vi.fn(async () => okResponse());
    await runSync("t", f as unknown as typeof fetch, { full: true, suppressNotify: true });
    expect(bodyOf(f).suppressNotify).toBe(true);
  });

  it("fullResyncV4が未設定でも、suppressNotifyは真にならない", async () => {
    // 初回同期に失敗した端末が最初の質問を書く経路。ここで抑止すると誰にも通知されない
    expect(await db.meta.get("fullResyncV4")).toBeUndefined();
    const f = vi.fn(async () => okResponse());
    await runSync("t", f as unknown as typeof fetch);
    const body = bodyOf(f);
    expect(body.since).toBe(0); // 全量同期にはなる
    expect(body.suppressNotify).toBe(false); // が、抑止はしない
  });
});
