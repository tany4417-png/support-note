import { ulid } from "ulid";
import { makeSender } from "./push-sender";
import type { Env } from "./index";

export function handleVapid(env: Env): Response {
  return Response.json({ publicKey: env.VAPID_PUBLIC_KEY });
}

export async function handleSubscribe(req: Request, env: Env): Promise<Response> {
  const b = (await req.json()) as { endpoint?: string; keys?: { p256dh?: string; auth?: string }; deviceLabel?: string };
  if (!b.endpoint || !b.keys?.p256dh || !b.keys?.auth) return new Response("bad request", { status: 400 });
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_label, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh=excluded.p256dh, auth=excluded.auth, device_label=excluded.device_label, failed_count=0`
  ).bind(ulid(), b.endpoint, b.keys.p256dh, b.keys.auth, b.deviceLabel ?? "", Date.now()).run();
  return Response.json({ ok: true });
}

export async function handleUnsubscribe(req: Request, env: Env): Promise<Response> {
  const b = (await req.json()) as { endpoint?: string };
  if (!b.endpoint) return new Response("bad request", { status: 400 });
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(b.endpoint).run();
  return Response.json({ ok: true });
}

export async function handlePushTest(req: Request, env: Env): Promise<Response> {
  const b = (await req.json()) as { endpoint?: string };
  const row = await env.DB.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint=?")
    .bind(b.endpoint ?? "").first<{ id: string; endpoint: string; p256dh: string; auth: string }>();
  if (!row) return new Response("subscription not found", { status: 404 });
  const res = await makeSender(env)(row, JSON.stringify({ title: "サポートノートのテスト通知" }));
  return Response.json({ ok: res.ok, status: res.status ?? 200 });
}
