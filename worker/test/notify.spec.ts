import { env } from "cloudflare:test";
import { describe, it, expect, afterEach } from "vitest";
import { notifySyncEvents, type SyncEvents } from "../src/notify";
import type { PushSender, SubRow } from "../src/push-sender";

const addSub = (id: string, endpoint = `https://push.example/${id}`) =>
  env.DB.prepare(
    "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_label, created_at) VALUES (?,?,?,?,?,?)"
  ).bind(id, endpoint, "k", "a", "test", 1).run();

const subExists = async (id: string) =>
  (await env.DB.prepare("SELECT id FROM push_subscriptions WHERE id=?").bind(id).first()) != null;

afterEach(async () => {
  await env.DB.prepare("DELETE FROM push_subscriptions").run();
});

function recordingSender(result: { ok: boolean; status?: number } = { ok: true }) {
  const calls: { sub: SubRow; payload: string }[] = [];
  const send: PushSender = async (sub, payload) => {
    calls.push({ sub, payload });
    return result;
  };
  return { send, calls };
}

describe("notifySyncEvents", () => {
  it("新規1件で購読へ届く（本文1行目・authorを含むタイトル）", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    const events: SyncEvents = { created: [{ id: "n1", author: "山田", body: "やること\n詳細" }], answeredDone: [] };

    await notifySyncEvents(env.DB, send, events, null);

    expect(calls).toHaveLength(1);
    expect(calls[0].sub.id).toBe("s1");
    expect(JSON.parse(calls[0].payload)).toEqual({ noteId: "n1", title: "山田: やること" });
  });

  it("selfEndpointと一致する購読には送らず、他の購読には届く", async () => {
    await addSub("s1", "https://push.example/self");
    await addSub("s2", "https://push.example/other");
    const { send, calls } = recordingSender();
    const events: SyncEvents = { created: [{ id: "n1", author: "山田", body: "本文" }], answeredDone: [] };

    await notifySyncEvents(env.DB, send, events, "https://push.example/self");

    expect(calls.map((c) => c.sub.id)).toEqual(["s2"]);
  });

  it("対応済み遷移で「対応済み: 」を先頭にしたタイトルが届く", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    const events: SyncEvents = { created: [], answeredDone: [{ id: "n2", body: "依頼内容\n詳細" }] };

    await notifySyncEvents(env.DB, send, events, null);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].payload)).toEqual({ noteId: "n2", title: "対応済み: 依頼内容" });
  });

  it("createdが4件以上のときは個別送信せず「新着 N件」を1通だけ送る（noteIdは先頭）", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    const events: SyncEvents = {
      created: [
        { id: "n1", author: "a", body: "1" },
        { id: "n2", author: "b", body: "2" },
        { id: "n3", author: "c", body: "3" },
        { id: "n4", author: "d", body: "4" },
      ],
      answeredDone: [],
    };

    await notifySyncEvents(env.DB, send, events, null);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].payload)).toEqual({ noteId: "n1", title: "新着 4件" });
  });

  it("createdが3件以下のときは集約せず個別に送る", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    const events: SyncEvents = {
      created: [
        { id: "n1", author: "a", body: "1件目" },
        { id: "n2", author: "b", body: "2件目" },
        { id: "n3", author: "c", body: "3件目" },
      ],
      answeredDone: [],
    };

    await notifySyncEvents(env.DB, send, events, null);

    expect(calls).toHaveLength(3);
  });

  it("410を返した購読は行が削除される", async () => {
    await addSub("s1");
    const { send } = recordingSender({ ok: false, status: 410 });
    const events: SyncEvents = { created: [{ id: "n1", author: null, body: "x" }], answeredDone: [] };

    await notifySyncEvents(env.DB, send, events, null);

    expect(await subExists("s1")).toBe(false);
  });

  it("404を返した購読も行が削除される", async () => {
    await addSub("s1");
    const { send } = recordingSender({ ok: false, status: 404 });
    const events: SyncEvents = { created: [{ id: "n1", author: null, body: "x" }], answeredDone: [] };

    await notifySyncEvents(env.DB, send, events, null);

    expect(await subExists("s1")).toBe(false);
  });

  it("404/410後のDELETEが例外を投げても他の購読への送信は止まらない", async () => {
    // DELETE FROM push_subscriptionsだけ例外を投げるfake D1（SELECTは実DBに委譲）。
    // ループが1件目のDELETE例外で中断せず、2件目のsendまで到達することを確認する
    await addSub("s1");
    await addSub("s2");
    const { send, calls } = recordingSender({ ok: false, status: 410 });
    const events: SyncEvents = { created: [{ id: "n1", author: null, body: "x" }], answeredDone: [] };
    const throwingDeleteDb = {
      prepare(query: string) {
        if (query.startsWith("DELETE FROM push_subscriptions")) {
          return { bind: () => ({ run: async () => { throw new Error("delete boom"); } }) };
        }
        return env.DB.prepare(query);
      },
    } as unknown as D1Database;

    await expect(notifySyncEvents(throwingDeleteDb, send, events, null)).resolves.toBeUndefined();

    expect(calls.map((c) => c.sub.id).sort()).toEqual(["s1", "s2"]);
  });

  it("404/410以外の失敗は購読を残し、他の購読への送信も続く", async () => {
    await addSub("s1");
    await addSub("s2");
    const calls: string[] = [];
    const send: PushSender = async (sub) => {
      calls.push(sub.id);
      if (sub.id === "s1") return { ok: false, status: 500 };
      return { ok: true };
    };
    const events: SyncEvents = { created: [{ id: "n1", author: null, body: "x" }], answeredDone: [] };

    await notifySyncEvents(env.DB, send, events, null);

    expect(calls.sort()).toEqual(["s1", "s2"]);
    expect(await subExists("s1")).toBe(true);
  });

  it("senderが例外を投げても他の購読への送信を止めない", async () => {
    await addSub("s1");
    await addSub("s2");
    const calls: string[] = [];
    const send: PushSender = async (sub) => {
      if (sub.id === "s1") throw new Error("boom");
      calls.push(sub.id);
      return { ok: true };
    };
    const events: SyncEvents = { created: [{ id: "n1", author: null, body: "x" }], answeredDone: [] };

    await expect(notifySyncEvents(env.DB, send, events, null)).resolves.toBeUndefined();

    expect(calls).toEqual(["s2"]);
  });

  it("authorがnullなら「名前なし」になる", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    const events: SyncEvents = { created: [{ id: "n1", author: null, body: "本文" }], answeredDone: [] };

    await notifySyncEvents(env.DB, send, events, null);

    expect(JSON.parse(calls[0].payload).title).toBe("名前なし: 本文");
  });

  it("authorが空文字でも「名前なし」になる", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    const events: SyncEvents = { created: [{ id: "n1", author: "", body: "本文" }], answeredDone: [] };

    await notifySyncEvents(env.DB, send, events, null);

    expect(JSON.parse(calls[0].payload).title).toBe("名前なし: 本文");
  });

  it("本文が空なら「(無題)」になる", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    const events: SyncEvents = { created: [{ id: "n1", author: "山田", body: "" }], answeredDone: [] };

    await notifySyncEvents(env.DB, send, events, null);

    expect(JSON.parse(calls[0].payload).title).toBe("山田: (無題)");
  });

  it("本文1行目が60字を超えると先頭60字に切り詰められる", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    const long = "あ".repeat(80);
    const events: SyncEvents = { created: [{ id: "n1", author: "山田", body: long }], answeredDone: [] };

    await notifySyncEvents(env.DB, send, events, null);

    const title = JSON.parse(calls[0].payload).title as string;
    expect(title).toBe(`山田: ${"あ".repeat(60)}`);
  });

  it("createdもansweredDoneも空なら何も送らない", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    const events: SyncEvents = { created: [], answeredDone: [] };

    await notifySyncEvents(env.DB, send, events, null);

    expect(calls).toHaveLength(0);
  });

  it("購読が0件でも例外を投げない", async () => {
    const { send } = recordingSender();
    const events: SyncEvents = { created: [{ id: "n1", author: "山田", body: "本文" }], answeredDone: [] };

    await expect(notifySyncEvents(env.DB, send, events, null)).resolves.toBeUndefined();
  });
});
