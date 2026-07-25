import { env } from "cloudflare:test";
import { describe, it, expect, afterEach } from "vitest";
import { buildTitle, classifyNoteChange, excerpt, notifySyncEvents, sendPending, type SyncEvents } from "../src/notify";
import { KIND_ANSWERED, KIND_APPENDED, KIND_CREATED, type PendingRow } from "../src/pending";
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

function note(over: Partial<{ body: string; author: string | null; answered: 0 | 1; deleted: 0 | 1 }> = {}) {
  return {
    id: "n1", body: "本文", importance: 0, createdAt: 1, updatedAt: 2, deleted: 0 as 0 | 1,
    folderId: null, orderKey: null, author: "山田" as string | null, answered: 0 as 0 | 1, ...over,
  };
}

function row(over: Partial<PendingRow> = {}): PendingRow {
  return {
    note_id: "n1", kinds: KIND_CREATED, actor: "山田", actor_endpoint: null,
    title_hint: "控え", editing_until: 0, editing_client_id: null, last_change_at: 1, ...over,
  };
}

describe("classifyNoteChange", () => {
  it("サーバーに行が無ければ新規", () => {
    expect(classifyNoteChange(null, note())).toBe(KIND_CREATED);
  });
  it("削除済みで届いた新規は対象外", () => {
    expect(classifyNoteChange(null, note({ deleted: 1 }))).toBe(0);
  });
  it("本文の文字数が増えたら追記", () => {
    expect(classifyNoteChange({ answered: 0, body: "質問" }, note({ body: "質問\n回答です" }))).toBe(KIND_APPENDED);
  });
  it("文字数が変わらない編集は対象外（チェックボックスの切り替え・誤字修正）", () => {
    expect(classifyNoteChange({ answered: 0, body: "- [ ] やる" }, note({ body: "- [x] やる" }))).toBe(0);
  });
  it("文字数が減る編集は対象外", () => {
    expect(classifyNoteChange({ answered: 0, body: "長い本文です" }, note({ body: "短い" }))).toBe(0);
  });
  it("未対応から対応済みへの遷移は対応済み", () => {
    expect(classifyNoteChange({ answered: 0, body: "質問" }, note({ body: "質問", answered: 1 }))).toBe(KIND_ANSWERED);
  });
  it("追記と対応済みは同時に立つ", () => {
    expect(classifyNoteChange({ answered: 0, body: "質問" }, note({ body: "質問\n回答", answered: 1 })))
      .toBe(KIND_APPENDED | KIND_ANSWERED);
  });
  it("対応済みから未対応への差し戻しは対象外", () => {
    expect(classifyNoteChange({ answered: 1, body: "質問" }, note({ body: "質問", answered: 0 }))).toBe(0);
  });
  it("ゴミ箱行きは対象外", () => {
    expect(classifyNoteChange({ answered: 0, body: "質問" }, note({ body: "質問と長い追記", deleted: 1 }))).toBe(0);
  });
});

describe("excerpt", () => {
  it("空行を飛ばして1行目を取り、見出し記号を外す", () => {
    expect(excerpt("\n\n## 見出し\n本文")).toBe("見出し");
  });
  it("空の本文は(無題)", () => {
    expect(excerpt("   ")).toBe("(無題)");
  });
  it("60字で切る", () => {
    expect(excerpt("あ".repeat(80)).length).toBe(60);
  });
});

describe("buildTitle", () => {
  it("新規は作成者の名前を使う（保留行のactorではなく）", () => {
    expect(buildTitle(row({ kinds: KIND_CREATED, actor: "大谷" }), note({ author: "山田", body: "質問です" })))
      .toBe("山田: 質問です");
  });
  it("他の人の追記は「が返信」", () => {
    expect(buildTitle(row({ kinds: KIND_APPENDED, actor: "大谷" }), note({ author: "山田", body: "質問です" })))
      .toBe("大谷が返信: 質問です");
  });
  it("投稿者本人の追記は「が追記」", () => {
    expect(buildTitle(row({ kinds: KIND_APPENDED, actor: "山田" }), note({ author: "山田", body: "質問です" })))
      .toBe("山田が追記: 質問です");
  });
  it("対応済みは「が対応済みに」", () => {
    expect(buildTitle(row({ kinds: KIND_ANSWERED, actor: "大谷" }), note({ author: "山田", body: "質問です" })))
      .toBe("大谷が対応済みに: 質問です");
  });
  it("追記と対応済みが重なったら1つの文面にまとめる", () => {
    expect(buildTitle(row({ kinds: KIND_APPENDED | KIND_ANSWERED, actor: "大谷" }), note({ author: "山田", body: "質問です" })))
      .toBe("大谷が返信して対応済みに: 質問です");
  });
  it("新規に他の変化が重なっても新規として扱う", () => {
    expect(buildTitle(row({ kinds: KIND_CREATED | KIND_APPENDED, actor: "大谷" }), note({ author: "山田", body: "質問です" })))
      .toBe("山田: 質問です");
  });
  it("メモの実体が無ければ控えを使い、名前はactorで代用する", () => {
    expect(buildTitle(row({ kinds: KIND_CREATED, actor: "大谷", title_hint: "消えた質問" }), undefined))
      .toBe("大谷: 消えた質問");
  });
  it("名前が空なら「名前なし」", () => {
    expect(buildTitle(row({ kinds: KIND_APPENDED, actor: null }), note({ author: null, body: "質問です" })))
      .toBe("名前なしが返信: 質問です");
  });
});

describe("sendPending", () => {
  it("変更した端末以外の全購読へ送る", async () => {
    await addSub("s1"); await addSub("s2");
    const { send, calls } = recordingSender();
    await sendPending(env.DB, send, [row({ actor_endpoint: "https://push.example/s1" })], new Map(), null);
    expect(calls.map((c) => c.sub.id)).toEqual(["s2"]);
  });

  it("同じ人の別の端末には届く（除外は購読endpoint単位）", async () => {
    await addSub("phone", "https://push.example/phone");
    await addSub("pc", "https://push.example/pc");
    const { send, calls } = recordingSender();
    await sendPending(env.DB, send, [row({ actor_endpoint: "https://push.example/pc" })], new Map(), null);
    expect(calls.map((c) => c.sub.id)).toEqual(["phone"]);
  });

  it("payloadはnoteIdとtitleを持つ", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    await sendPending(env.DB, send, [row({ note_id: "n9", actor: "大谷", kinds: KIND_APPENDED })], new Map(), null);
    expect(JSON.parse(calls[0].payload)).toEqual({ noteId: "n9", title: "大谷が返信: 控え" });
  });

  it("4件以上は1通に集約し、最も古い変化のメモを開く", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    const rows = [
      row({ note_id: "a", last_change_at: 300 }), row({ note_id: "b", last_change_at: 100 }),
      row({ note_id: "c", last_change_at: 200 }), row({ note_id: "d", last_change_at: 400 }),
    ];
    await sendPending(env.DB, send, rows, new Map(), null);
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].payload)).toEqual({ noteId: "b", title: "更新 4件" });
  });

  it("集約の宛先は、含まれる変更者の端末をすべて外す", async () => {
    await addSub("s1", "https://push.example/s1");
    await addSub("s2", "https://push.example/s2");
    await addSub("s3", "https://push.example/s3");
    const { send, calls } = recordingSender();
    const rows = [
      row({ note_id: "a", actor_endpoint: "https://push.example/s1" }),
      row({ note_id: "b", actor_endpoint: "https://push.example/s2" }),
      row({ note_id: "c", actor_endpoint: "https://push.example/s1" }),
      row({ note_id: "d", actor_endpoint: "https://push.example/s2" }),
    ];
    await sendPending(env.DB, send, rows, new Map(), null);
    expect(calls.length).toBe(1);
    expect(calls[0].sub.id).toBe("s3");
  });

  it("集約の宛先が1台も残らないなら、集約せず個別に送る", async () => {
    await addSub("s1", "https://push.example/s1");
    await addSub("s2", "https://push.example/s2");
    const { send, calls } = recordingSender();
    const rows = [
      row({ note_id: "a", actor_endpoint: "https://push.example/s1" }),
      row({ note_id: "b", actor_endpoint: "https://push.example/s2" }),
      row({ note_id: "c", actor_endpoint: "https://push.example/s1" }),
      row({ note_id: "d", actor_endpoint: "https://push.example/s2" }),
    ];
    await sendPending(env.DB, send, rows, new Map(), null);
    // 4行それぞれが、自分の変更者以外の1台へ送られる
    expect(calls.length).toBe(4);
  });

  it("410の購読は行ごと削除される", async () => {
    await addSub("s1");
    const { send } = recordingSender({ ok: false, status: 410 });
    await sendPending(env.DB, send, [row()], new Map(), null);
    expect(await subExists("s1")).toBe(false);
  });

  it("1件の送信失敗で他の購読への送信は止まらない", async () => {
    await addSub("s1"); await addSub("s2");
    const calls: string[] = [];
    const send: PushSender = async (sub) => {
      calls.push(sub.id);
      if (sub.id === "s1") throw new Error("boom");
      return { ok: true };
    };
    await sendPending(env.DB, send, [row()], new Map(), null);
    expect(calls).toEqual(["s1", "s2"]);
  });

  it("メモの実体があれば、見出しは保留時の控えでなく現在の本文から作る", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    const notes = new Map([["n1", note({ body: "確定した質問文", author: "山田" })]]);
    await sendPending(env.DB, send, [row({ kinds: KIND_CREATED, title_hint: "書きかけ" })], notes, null);
    expect(JSON.parse(calls[0].payload).title).toBe("山田: 確定した質問文");
  });

  it("行が空なら何もしない", async () => {
    await addSub("s1");
    const { send, calls } = recordingSender();
    await sendPending(env.DB, send, [], new Map(), null);
    expect(calls.length).toBe(0);
  });
});

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
