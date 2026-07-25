import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addPending, claimDuePending, clearAnsweredBit, deletePending, purgeOrphanPending,
  releaseEditing, touchEditing, EDIT_HOLD_MS, KIND_ANSWERED, KIND_APPENDED, KIND_CREATED,
  type PendingContext,
} from "../src/pending";

const NOW = 1_800_000_000_000;

function ctx(over: Partial<PendingContext> = {}): PendingContext {
  return {
    clientId: "client-a", actorName: "山田", selfEndpoint: "https://push.example/a",
    editingNoteId: null, now: NOW, ...over,
  };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM pending_notifications").run();
  await env.DB.prepare("DELETE FROM notes").run();
});

describe("pending", () => {
  it("変化を積むと1行できる", async () => {
    await addPending(env.DB, "n1", KIND_CREATED, "質問です", ctx());
    const rows = await claimDuePending(env.DB, NOW);
    expect(rows.length).toBe(1);
    expect(rows[0].kinds).toBe(KIND_CREATED);
    expect(rows[0].actor).toBe("山田");
    expect(rows[0].title_hint).toBe("質問です");
  });

  it("同じメモの変化はビットで積み上がり、1行のまま", async () => {
    await addPending(env.DB, "n1", KIND_APPENDED, "質問です", ctx());
    await addPending(env.DB, "n1", KIND_ANSWERED, "質問です", ctx({ now: NOW + 100 }));
    const rows = await claimDuePending(env.DB, NOW + 200);
    expect(rows.length).toBe(1);
    expect(rows[0].kinds).toBe(KIND_APPENDED | KIND_ANSWERED);
    expect(rows[0].last_change_at).toBe(NOW + 100);
  });

  it("編集中の申告がある行は確保されない", async () => {
    await addPending(env.DB, "n1", KIND_CREATED, "書きかけ", ctx({ editingNoteId: "n1" }));
    expect((await claimDuePending(env.DB, NOW)).length).toBe(0);
  });

  it("申告から5分経つと確保される", async () => {
    await addPending(env.DB, "n1", KIND_CREATED, "書きかけ", ctx({ editingNoteId: "n1" }));
    expect((await claimDuePending(env.DB, NOW + EDIT_HOLD_MS + 1)).length).toBe(1);
  });

  it("申告した端末が別のメモを申告すると、前のメモの申告は解除される", async () => {
    await addPending(env.DB, "n1", KIND_CREATED, "1件目", ctx({ editingNoteId: "n1" }));
    await releaseEditing(env.DB, ctx({ editingNoteId: "n2", now: NOW + 100 }));
    expect((await claimDuePending(env.DB, NOW + 100)).length).toBe(1);
  });

  it("別の端末は申告を解除できない", async () => {
    await addPending(env.DB, "n1", KIND_CREATED, "書きかけ", ctx({ editingNoteId: "n1" }));
    await releaseEditing(env.DB, ctx({ clientId: "client-b", editingNoteId: null, now: NOW + 100 }));
    expect((await claimDuePending(env.DB, NOW + 100)).length).toBe(0);
  });

  it("購読していない端末（selfEndpointがnull）でも申告と解除ができる", async () => {
    const noPush = { selfEndpoint: null };
    await addPending(env.DB, "n1", KIND_CREATED, "書きかけ", ctx({ ...noPush, editingNoteId: "n1" }));
    expect((await claimDuePending(env.DB, NOW)).length).toBe(0);
    await releaseEditing(env.DB, ctx({ ...noPush, editingNoteId: null, now: NOW + 100 }));
    expect((await claimDuePending(env.DB, NOW + 100)).length).toBe(1);
  });

  it("touchEditingは既存行の申告を延長する（行が無ければ何もしない）", async () => {
    await touchEditing(env.DB, ctx({ editingNoteId: "missing" }));
    expect((await claimDuePending(env.DB, NOW)).length).toBe(0);
    await addPending(env.DB, "n1", KIND_APPENDED, "本文", ctx());
    await touchEditing(env.DB, ctx({ editingNoteId: "n1", now: NOW + 100 }));
    expect((await claimDuePending(env.DB, NOW + 100)).length).toBe(0);
  });

  it("対応済みのビットを落とし、0になったら行ごと消える", async () => {
    await addPending(env.DB, "n1", KIND_ANSWERED, "本文", ctx());
    await clearAnsweredBit(env.DB, "n1");
    expect((await claimDuePending(env.DB, NOW)).length).toBe(0);
    await addPending(env.DB, "n2", KIND_APPENDED | KIND_ANSWERED, "本文", ctx());
    await clearAnsweredBit(env.DB, "n2");
    const rows = await claimDuePending(env.DB, NOW);
    expect(rows.length).toBe(1);
    expect(rows[0].kinds).toBe(KIND_APPENDED);
  });

  it("確保した行は消えるので、二度は取れない", async () => {
    await addPending(env.DB, "n1", KIND_CREATED, "本文", ctx());
    expect((await claimDuePending(env.DB, NOW)).length).toBe(1);
    expect((await claimDuePending(env.DB, NOW)).length).toBe(0);
  });

  it("deletePendingで行が消える", async () => {
    await addPending(env.DB, "n1", KIND_CREATED, "本文", ctx());
    await deletePending(env.DB, "n1");
    expect((await claimDuePending(env.DB, NOW)).length).toBe(0);
  });

  it("実体の無い保留行は掃除される", async () => {
    await addPending(env.DB, "ghost", KIND_CREATED, "本文", ctx());
    await purgeOrphanPending(env.DB);
    expect((await claimDuePending(env.DB, NOW)).length).toBe(0);
  });
});
