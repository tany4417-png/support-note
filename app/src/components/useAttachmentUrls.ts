import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getImageBlob } from "../lib/attachments";
import { db } from "../lib/db";
import type { AttachmentMeta } from "../lib/types";

export function useAttachmentUrls(
  noteId: string,
  limit?: number,
  opts?: { thumb?: boolean }
): { metas: AttachmentMeta[]; urls: Record<string, string> } {
  const thumb = opts?.thumb ?? false;
  const metas = useLiveQuery(
    async () => {
      const all = await db.attachments.where("noteId").equals(noteId).filter((a) => a.deleted === 0).toArray();
      return limit ? all.slice(0, limit) : all;
    },
    [noteId, limit],
    [] as AttachmentMeta[]
  );
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const created: string[] = [];
    void (async () => {
      const token = localStorage.getItem("supportnote.token") ?? "";
      const next: Record<string, string> = {};
      for (const m of metas) {
        const blob = await getImageBlob(m.id, token, undefined, { thumb });
        if (blob) {
          const u = URL.createObjectURL(blob);
          created.push(u);
          next[m.id] = u;
        }
      }
      if (alive) setUrls(next);
    })();
    return () => {
      alive = false;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [metas, thumb]);
  return { metas, urls };
}
