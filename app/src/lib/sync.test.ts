import { beforeEach, describe, expect, it, vi } from "vitest";
import { addImageFromBlob, softDeleteAttachment } from "./attachments";
import { db, resetDbForTests } from "./db";
import { createFolder } from "./folders";
import { createNote, updateNote } from "./notes";
import { runSync } from "./sync";
import type { SyncResponse } from "./types";

beforeEach(async () => {
  await resetDbForTests();
});

function okFetch(over: Partial<SyncResponse> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ now: 1000, notes: [], attachments: [], ...over }));
  }) as typeof fetch;
  return { f, calls };
}

describe("runSync", () => {
  it("削除済み(deleted=1)の添付はblobをPUTで再送せず、tombstoneはPOSTで送る", async () => {
    // PUTを再送すると、サーバー側でメタ行が「生存・現在時刻」で上書きされ、同じ同期でpushする
    // 削除tombstoneがLWWで負けて削除済み添付が復活する（2026-07-21 実バグの回帰テスト）
    await db.meta.put({ key: "fullResyncV4", value: 1 });
    const meta = await addImageFromBlob("N1", new Blob([new Uint8Array([1])], { type: "image/png" }));
    await softDeleteAttachment(meta.id);
    const { f, calls } = okFetch();
    await runSync("tok", f);
    const puts = calls.filter((c) => c.init.method === "PUT");
    expect(puts).toHaveLength(0);
    const body = JSON.parse(String(calls.find((c) => c.url === "/api/sync")?.init.body));
    expect(body.attachments.some((a: { id: string; deleted: 0 | 1 }) => a.id === meta.id && a.deleted === 1)).toBe(true);
  });

  it("dirtyなメモだけを送り、dirtyフィールドは含めない", async () => {
    // full（fullResyncV4未実施時の自動全量）ではなく通常のdirty収集だけを検証したいので、
    // 既に全量同期済みの端末を装っておく（Fix1で full時は全行dirtyになる仕様のため）
    await db.meta.put({ key: "fullResyncV4", value: 1 });
    const a = await createNote("a");
    await createNote("b");
    await db.notes.update(a.id, { dirty: 0 as const });
    const { f, calls } = okFetch();
    await runSync("tok", f);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].body).toBe("b");
    expect(body.notes[0].dirty).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("受信は新しい方だけ適用する（LWW）", async () => {
    const a = await createNote("local");
    const incomingNew = {
      id: "REMOTE1", body: "r", importance: 0 as const, createdAt: 1, updatedAt: 1, deleted: 0 as const,
      folderId: null,
    };
    const incomingOld = {
      id: a.id, body: "stale", importance: 0 as const, createdAt: 1, updatedAt: a.updatedAt - 1, deleted: 0 as const,
      folderId: null,
    };
    const { f } = okFetch({ notes: [incomingNew, incomingOld] });
    const result = await runSync("tok", f);
    expect(result.pulled).toBe(2);
    expect((await db.notes.get("REMOTE1"))?.body).toBe("r");
    expect((await db.notes.get(a.id))?.body).toBe("local");
  });

  it("同時刻・別内容はサーバーが勝つ（同一updatedAtの膠着解消・Fix1）", async () => {
    // 実害の再現: Dexie v2アップグレードの不具合で、ローカルのfolderIdだけがupdatedAtを
    // 変えずにサーバーと異なる値になり得た。以前は適用条件が厳密な">"だったため、
    // updatedAtが同じ限り一生収束しなかった（膠着）。">="にしたことで、同時刻なら
    // サーバー側の値を採用して収束することを確認する
    const a = await createNote("local");
    await db.notes.update(a.id, { dirty: 0 as const, folderId: null });
    const incomingSameTime = {
      id: a.id,
      body: "server-side",
      importance: 0 as const,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt, // 同一updatedAt
      deleted: 0 as const,
      folderId: "FOLDER-X",
    };
    const { f } = okFetch({ notes: [incomingSameTime] });
    await runSync("tok", f);
    const cur = await db.notes.get(a.id);
    expect(cur?.body).toBe("server-side");
    expect(cur?.folderId).toBe("FOLDER-X");
    expect(cur?.dirty).toBe(0);
  });

  it("同期中に入った編集はdirtyのまま残る（スナップショット競合）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      const a = await createNote("original");

      const wrapped = (async () => {
        // fetchの応答が返ってくる前（サーバー往復の待ち時間中）に編集が入るケースを再現する
        vi.setSystemTime(1_000_050);
        await updateNote(a.id, { body: "edited-during-sync" });
        return new Response(JSON.stringify({ now: 2_000_000, notes: [], attachments: [] }));
      }) as typeof fetch;

      const result = await runSync("tok", wrapped);
      expect(result.pulled).toBe(0);

      const cur = await db.notes.get(a.id);
      expect(cur?.dirty).toBe(1);
      expect(cur?.body).toBe("edited-during-sync");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushした行のエコーバックは状態を壊さない", async () => {
    const a = await createNote("original");
    const echoBack = {
      id: a.id,
      body: a.body,
      importance: a.importance,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      deleted: a.deleted,
      folderId: a.folderId,
    };
    const { f } = okFetch({ notes: [echoBack] });

    const result = await runSync("tok", f);
    expect(result.pulled).toBe(1);

    const cur = await db.notes.get(a.id);
    expect(cur?.dirty).toBe(0);
    expect(cur?.body).toBe("original");
  });

  it("成功後にdirtyが0になりlastSyncが更新される", async () => {
    await createNote("a");
    const { f } = okFetch();
    const result = await runSync("tok", f);
    expect(result.pushed).toBe(1);
    expect(await db.notes.where("dirty").equals(1).count()).toBe(0);
    expect((await db.meta.get("lastSync"))?.value).toBe(1000);
  });

  it("サーバーエラー時はthrowし、dirtyとlastSyncは変わらない", async () => {
    await createNote("a");
    const f = (async () => new Response("err", { status: 500 })) as typeof fetch;
    await expect(runSync("tok", f)).rejects.toThrow();
    expect(await db.notes.where("dirty").equals(1).count()).toBe(1);
    expect(await db.meta.get("lastSync")).toBeUndefined();
  });

  it("purgedIdsが返るとローカルからそのメモを物理削除する（サーバーで既に消えた編集を復活させない）", async () => {
    const a = await createNote("purged elsewhere");
    const { f } = okFetch({ purgedIds: [a.id] });
    await runSync("tok", f);
    expect(await db.notes.get(a.id)).toBeUndefined();
  });
});

describe("runSync 全量再同期（fullResyncV4）", () => {
  it("旧バージョンからの更新直後（fullResyncV4フラグが無い）はsince=0で送り、成功後にフラグが立つ", async () => {
    const { f, calls } = okFetch();
    await runSync("tok", f);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.since).toBe(0);
    expect((await db.meta.get("fullResyncV4"))?.value).toBeTruthy();
  });

  it("2回目以降の通常呼び出しはフラグが立っているためlastSyncをsinceに使う", async () => {
    const { f: f1 } = okFetch({ now: 500 });
    await runSync("tok", f1); // 1回目でフラグが立ち、lastSyncが500になる

    const { f: f2, calls } = okFetch({ now: 999 });
    await runSync("tok", f2); // 2回目は通常同期
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.since).toBe(500);
  });

  it("options.full=trueを渡すと、フラグの有無やlastSyncの値に関わらずsince=0で送る", async () => {
    await db.meta.put({ key: "fullResyncV4", value: 1 });
    await db.meta.put({ key: "lastSync", value: 12345 });
    const { f, calls } = okFetch();
    await runSync("tok", f, { full: true });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.since).toBe(0);
  });

  it("full:trueでの同期成功後もlastSyncは応答のnowに更新される", async () => {
    const { f } = okFetch({ now: 777 });
    await runSync("tok", f, { full: true });
    expect((await db.meta.get("lastSync"))?.value).toBe(777);
  });

  it("full時はdirtyでない既存メモ・フォルダ・添付もすべて送信される（送信側の全量押し直し・Fix1）", async () => {
    const a = await createNote("a");
    await db.notes.update(a.id, { dirty: 0 as const });
    const b = await createFolder("folder-b", null);
    await db.folders.update(b.id, { dirty: 0 as const });
    const att = await addImageFromBlob(a.id, new Blob([new Uint8Array([1])], { type: "image/png" }));
    await db.attachments.update(att.id, { dirty: 0 as const });

    const { f, calls } = okFetch();
    await runSync("tok", f, { full: true });

    const syncCall = calls.find((c) => c.url === "/api/sync")!;
    const body = JSON.parse(String(syncCall.init.body));
    expect(body.notes.map((n: { id: string }) => n.id)).toContain(a.id);
    expect(body.folders.map((fl: { id: string }) => fl.id)).toContain(b.id);
    // 添付は実体があるものだけPUTも走る（Fix1: 件数が少ないので許容する仕様）
    expect(calls.some((c) => c.url.startsWith("/api/attachments/") && c.init.method === "PUT")).toBe(true);
  });

  it("full時は削除済み（tombstone）のメモも取りこぼさず送信する", async () => {
    // 過去の不具合の再現: 削除はしたがdirtyが立たない/消えたままサーバーに届いていない状態
    const a = await createNote("消される予定だった");
    await db.notes.update(a.id, { deleted: 1 as const, dirty: 0 as const });
    const { f, calls } = okFetch();
    await runSync("tok", f, { full: true });
    const body = JSON.parse(String(calls[0].init.body));
    const sent = body.notes.find((n: { id: string }) => n.id === a.id);
    expect(sent?.deleted).toBe(1);
  });

  it("2回目以降の通常呼び出しでは全行dirty化は行われず、実際にdirtyな行だけを送る", async () => {
    await createNote("a");
    const { f: f1 } = okFetch();
    await runSync("tok", f1, { full: true }); // fullResyncV4を立てる（送信済みのdirtyは全部クリアされる）

    await createNote("b");
    const { f: f2, calls } = okFetch();
    await runSync("tok", f2);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].body).toBe("b");
  });
});

describe("runSync フォルダ", () => {
  it("dirtyなフォルダだけを送り、dirtyフィールドは含めない", async () => {
    // full（fullResyncV4未実施時の自動全量）ではなく通常のdirty収集だけを検証したいので、
    // 既に全量同期済みの端末を装っておく（Fix1で full時は全行dirtyになる仕様のため）
    await db.meta.put({ key: "fullResyncV4", value: 1 });
    const a = await createFolder("a", null);
    await createFolder("b", null);
    await db.folders.update(a.id, { dirty: 0 as const });
    const { f, calls } = okFetch();
    await runSync("tok", f);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.folders).toHaveLength(1);
    expect(body.folders[0].name).toBe("b");
    expect(body.folders[0].dirty).toBeUndefined();
  });

  it("受信フォルダはLWWで適用されdirty=0になる", async () => {
    const local = await createFolder("local", null);
    const incomingNew = { id: "RFOLDER1", name: "r", parentId: null, createdAt: 1, updatedAt: 1, deleted: 0 as const };
    const incomingOld = { id: local.id, name: "stale", parentId: null, createdAt: 1, updatedAt: local.updatedAt - 1, deleted: 0 as const };
    const { f } = okFetch({ folders: [incomingNew, incomingOld] });
    const result = await runSync("tok", f);
    expect(result.pulled).toBe(2);
    const remote = await db.folders.get("RFOLDER1");
    expect(remote?.name).toBe("r");
    expect(remote?.dirty).toBe(0);
    const localAfter = await db.folders.get(local.id);
    expect(localAfter?.name).toBe("local");
  });

  it("pushしたフォルダのdirtyがクリアされ、lastSyncも更新される", async () => {
    await createFolder("f", null);
    const { f } = okFetch();
    const result = await runSync("tok", f);
    expect(result.pushed).toBe(1);
    expect(await db.folders.where("dirty").equals(1).count()).toBe(0);
  });

  it("応答にfoldersが無くても動く（?? []）", async () => {
    await createFolder("f", null);
    const f = (async () => new Response(JSON.stringify({ now: 1000, notes: [], attachments: [] }))) as typeof fetch;
    const result = await runSync("tok", f);
    expect(result.pulled).toBe(0);
    expect(await db.folders.where("dirty").equals(1).count()).toBe(0);
  });

  it("purgedIdsにフォルダidが来たらローカルから物理削除する", async () => {
    const folder = await createFolder("消えるフォルダ", null);
    const { f } = okFetch({ purgedIds: [folder.id] });
    await runSync("tok", f);
    expect(await db.folders.get(folder.id)).toBeUndefined();
  });
});

describe("runSync 添付アップロード", () => {
  it("dirtyな添付を先にPUTしてからJSON同期する", async () => {
    await addImageFromBlob("N1", new Blob([new Uint8Array([1])], { type: "image/png" }));
    const { f, calls } = okFetch();
    await runSync("tok", f);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toMatch(/^\/api\/attachments\/.+\?noteId=N1$/);
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[1].url).toBe("/api/sync");
  });

  it("実体が無い添付メタ（他端末由来）はPUTしない", async () => {
    await db.attachments.put({ id: "X", noteId: "N", mime: "image/png", size: 1, createdAt: 1, updatedAt: 1, deleted: 0, dirty: 1 });
    const { f, calls } = okFetch();
    await runSync("tok", f);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/sync");
  });

  it(":thumbキーのサムネblobはアップロード対象に混ざらない（attachmentsメタが無いため走査されない）", async () => {
    const meta = await addImageFromBlob("N1", new Blob([new Uint8Array([1])], { type: "image/png" }));
    // addImageFromBlobが作る:thumbレコードに加え、他経路で紛れ込むケースも想定して明示的にも置いておく
    await db.attachmentBlobs.put({ id: `${meta.id}:thumb`, blob: new Blob([new Uint8Array([2])], { type: "image/jpeg" }) });
    const { f, calls } = okFetch();
    await runSync("tok", f);
    const uploadCalls = calls.filter((c) => c.url.startsWith("/api/attachments/"));
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].url).not.toContain("thumb");
  });
});

describe("runSync 添付アップロード失敗時のスキップ（画像1件の失敗で全体を止めない）", () => {
  // 添付PUTだけを失敗させ、/api/syncは通常どおり応答するfetchモック。shouldFailUrlに一致するPUT先だけ
  // 500を返し、他（/api/attachments/の別idや/api/sync）は成功応答を返す
  function partialFailFetch(shouldFailUrl: (url: string) => boolean, over: Partial<SyncResponse> = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init: init ?? {} });
      if (u.startsWith("/api/attachments/") && shouldFailUrl(u)) {
        return new Response("upload error", { status: 500 });
      }
      return new Response(JSON.stringify({ now: 1000, notes: [], attachments: [], ...over }));
    }) as typeof fetch;
    return { f, calls };
  }

  it("(a) 添付PUTが失敗しても/api/syncは実行され、メモ本文の同期は止まらない", async () => {
    await createNote("body-note"); // dirtyなメモ。添付PUT失敗に巻き込まれず送信されることを確認する
    await addImageFromBlob("N1", new Blob([new Uint8Array([1])], { type: "image/png" }));
    const { f, calls } = partialFailFetch(() => true);

    const result = await runSync("tok", f);

    const syncCall = calls.find((c) => c.url === "/api/sync");
    expect(syncCall).toBeDefined();
    const body = JSON.parse(String(syncCall!.init.body));
    expect(body.notes.some((n: { body: string }) => n.body === "body-note")).toBe(true);
    expect(await db.notes.where("dirty").equals(1).count()).toBe(0); // メモ側は従来どおり成功
    expect(result.failedAttachments).toBe(1);
  });

  it("(b) 失敗した添付のdirtyは残る（次回リトライ対象のまま）", async () => {
    const meta = await addImageFromBlob("N1", new Blob([new Uint8Array([1])], { type: "image/png" }));
    const { f } = partialFailFetch(() => true);

    await runSync("tok", f);

    const cur = await db.attachments.get(meta.id);
    expect(cur?.dirty).toBe(1);
  });

  it("(c) failedAttachmentsは失敗した添付だけを数え、成功した分は含まない", async () => {
    const ok = await addImageFromBlob("N1", new Blob([new Uint8Array([1])], { type: "image/png" }));
    const bad = await addImageFromBlob("N2", new Blob([new Uint8Array([2])], { type: "image/png" }));
    const { f } = partialFailFetch((u) => u.includes(bad.id));

    const result = await runSync("tok", f);

    expect(result.failedAttachments).toBe(1);
    expect((await db.attachments.get(ok.id))?.dirty).toBe(0);
    expect((await db.attachments.get(bad.id))?.dirty).toBe(1);
  });

  it("(d) 添付PUTが例外を投げても（ネットワーク断など）握りつぶしてスキップし、failedAttachmentsに数える", async () => {
    await addImageFromBlob("N1", new Blob([new Uint8Array([1])], { type: "image/png" }));
    const f = (async (url: RequestInfo | URL) => {
      if (String(url).startsWith("/api/attachments/")) throw new Error("network down");
      return new Response(JSON.stringify({ now: 1000, notes: [], attachments: [] }));
    }) as typeof fetch;

    const result = await runSync("tok", f);

    expect(result.failedAttachments).toBe(1);
  });

  it("全件成功時はfailedAttachments=0で従来どおりdirtyがクリアされる", async () => {
    const meta = await addImageFromBlob("N1", new Blob([new Uint8Array([1])], { type: "image/png" }));
    const { f } = okFetch();

    const result = await runSync("tok", f);

    expect(result.failedAttachments).toBe(0);
    expect((await db.attachments.get(meta.id))?.dirty).toBe(0);
  });
});
