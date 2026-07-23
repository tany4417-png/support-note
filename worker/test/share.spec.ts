import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const TOKEN = { Authorization: "Bearer test-token" };

async function pull() {
  const res = await SELF.fetch("https://example.com/api/sync", {
    method: "POST", headers: { ...TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ since: 0, notes: [], attachments: [] }),
  });
  return res.json() as Promise<any>;
}

describe("/api/share", () => {
  it("テキストが無印のメモになる（受信タグは付けない）", async () => {
    const form = new FormData();
    form.append("text", "https://example.com/article");
    const res = await SELF.fetch("https://example.com/api/share", { method: "POST", headers: TOKEN, body: form });
    expect(res.status).toBe(200);
    const data = await pull();
    expect(data.notes).toHaveLength(1);
    expect(data.notes[0].body).toBe("https://example.com/article");
  });

  it("画像ファイルが添付付きメモになる", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([9, 8, 7])], "a.png", { type: "image/png" }));
    const res = await SELF.fetch("https://example.com/api/share", { method: "POST", headers: TOKEN, body: form });
    expect(res.status).toBe(200);
    const { noteId } = await res.json() as any;
    const data = await pull();
    expect(data.attachments).toHaveLength(1);
    expect(data.attachments[0].noteId).toBe(noteId);
    const get = await SELF.fetch(`https://example.com/api/attachments/${data.attachments[0].id}`, { headers: TOKEN });
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("空のフォームは400", async () => {
    const res = await SELF.fetch("https://example.com/api/share", { method: "POST", headers: TOKEN, body: new FormData() });
    expect(res.status).toBe(400);
  });

  it("CRLFはLFに正規化される", async () => {
    const form = new FormData();
    form.append("text", "a\r\n- [ ] x");
    const res = await SELF.fetch("https://example.com/api/share", { method: "POST", headers: TOKEN, body: form });
    expect(res.status).toBe(200);
    const { noteId } = (await res.json()) as any;
    const data = await pull();
    const note = data.notes.find((n: any) => n.id === noteId);
    expect(note.body).toBe("a\n- [ ] x");
  });

  it("author欄があればメモのauthorに設定される（任意項目）", async () => {
    const form = new FormData();
    form.append("text", "問い合わせ内容");
    form.append("author", "山田");
    const res = await SELF.fetch("https://example.com/api/share", { method: "POST", headers: TOKEN, body: form });
    expect(res.status).toBe(200);
    const { noteId } = (await res.json()) as any;
    const data = await pull();
    const note = data.notes.find((n: any) => n.id === noteId);
    expect(note.author).toBe("山田");
  });
});
