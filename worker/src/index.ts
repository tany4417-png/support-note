import { requireAuth } from "./auth";
import { handleSync } from "./sync";
import { handleAttachmentGet, handleAttachmentPut } from "./attachments";
import { handleShare } from "./share";
import { handleVapid, handleSubscribe, handleUnsubscribe, handlePushTest } from "./push";

export interface Env {
  DB: D1Database;
  ATT: R2Bucket;
  API_TOKEN: string;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      const denied = requireAuth(req, env);
      if (denied) return denied;
      if (url.pathname === "/api/health") return Response.json({ ok: true });
      if (url.pathname === "/api/sync" && req.method === "POST") return handleSync(req, env, ctx);
      if (url.pathname === "/api/share" && req.method === "POST") return handleShare(req, env);
      if (url.pathname === "/api/push/vapid" && req.method === "GET") return handleVapid(env);
      if (url.pathname === "/api/push/subscribe" && req.method === "POST") return handleSubscribe(req, env);
      if (url.pathname === "/api/push/subscribe" && req.method === "DELETE") return handleUnsubscribe(req, env);
      if (url.pathname === "/api/push/test" && req.method === "POST") return handlePushTest(req, env);
      const attMatch = url.pathname.match(/^\/api\/attachments\/([A-Za-z0-9]+)$/);
      if (attMatch && req.method === "GET") return handleAttachmentGet(attMatch[1], env);
      if (attMatch && req.method === "PUT") return handleAttachmentPut(attMatch[1], req, env);
      return new Response("not found", { status: 404 });
    }
    return env.ASSETS.fetch(req);
  },
};
