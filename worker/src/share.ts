import { ulid } from "ulid";
import type { Env } from "./index";
import { upsertAttachment, upsertNote } from "./sync";

export async function handleShare(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const text = form.get("text");
  const authorField = form.get("author");
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  const hasText = typeof text === "string" && text.trim() !== "";
  if (!hasText && files.length === 0) return new Response("empty", { status: 400 });

  const now = Date.now();
  const noteId = ulid();
  const body = hasText ? (text as string).trim().replace(/\r\n?/g, "\n") : "";
  const author = typeof authorField === "string" && authorField.trim() !== "" ? authorField.trim() : null;
  await upsertNote(env.DB, { id: noteId, body, importance: 0, createdAt: now, updatedAt: now, deleted: 0, folderId: null, author });

  for (const f of files) {
    const attId = ulid();
    const mime = f.type || "application/octet-stream";
    const data = await f.arrayBuffer();
    await env.ATT.put(`att/${attId}`, data, { httpMetadata: { contentType: mime } });
    await upsertAttachment(env.DB, { id: attId, noteId, mime, size: data.byteLength, createdAt: now, updatedAt: now, deleted: 0 });
  }
  return Response.json({ ok: true, noteId });
}
