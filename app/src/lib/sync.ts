import { db } from "./db";
import { thumbKey } from "./attachments";
import type { AttachmentMeta, Folder, Note, SyncResponse } from "./types";

export type SyncResult = { pushed: number; pulled: number; failedAttachments: number };

// 同期時サーバープッシュ通知の送信対象から自分自身の端末を除外するための購読endpoint。
// 未対応環境・未購読・取得失敗（例外）はすべてnullを返す。取得失敗でsync自体を壊さないためtry/catchで握る
async function getSelfEndpoint(): Promise<string | null> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

function stripNote(n: Note) {
  const { dirty: _dirty, ...rest } = n;
  return rest;
}

function stripAtt(a: AttachmentMeta) {
  const { dirty: _dirty, ...rest } = a;
  return rest;
}

function stripFolder(f: Folder) {
  const { dirty: _dirty, ...rest } = f;
  return rest;
}

export async function runSync(
  token: string,
  fetchFn: typeof fetch = fetch,
  options?: { full?: boolean }
): Promise<SyncResult> {
  // 旧バージョンのクライアントがfolders配列を無視したままlastSyncだけ進めてしまうと、新バージョンに
  // 更新してもサーバーは「送信済み」と判断し、以後foldersが二度と届かない。fullResyncV4フラグが
  // 無い（＝このロジック導入後まだ一度も全量同期していない）端末では、通常呼び出しでも一度だけ
  // since=0の全量同期に切り替えて取りこぼしを回収する。適用側はLWWなので全量再受信しても安全
  const fullResyncDone = (await db.meta.get("fullResyncV4")) !== undefined;
  const full = options?.full === true || !fullResyncDone;
  const since = full ? 0 : Number((await db.meta.get("lastSync"))?.value ?? 0);

  // Fix1: 送信側の全量押し直し。過去の不具合で「サーバーへ届かないままdirtyフラグだけが消えた」
  // 未送信の行がローカルに残っている疑いがあるため、full時は通常のdirty収集の前に
  // 全notes・全folders・全attachments（tombstone＝deleted=1の行も含む）のdirtyを1に立てておく。
  // これで以後の収集で全件が拾われ全量pushされる。LWW（受信側）とpurgedIdsガードがあるため、
  // 実際には変更が無い行を再送しても冪等で安全。添付は実体（attachmentBlobs）があるものだけPUTが
  // 走るが、件数は少ないので許容する
  if (full) {
    await db.notes.toCollection().modify({ dirty: 1 });
    await db.folders.toCollection().modify({ dirty: 1 });
    await db.attachments.toCollection().modify({ dirty: 1 });
  }

  const dirtyNotes = await db.notes.where("dirty").equals(1).toArray();
  const dirtyAtts = await db.attachments.where("dirty").equals(1).toArray();
  const dirtyFolders = await db.folders.where("dirty").equals(1).toArray();

  // 添付PUTは1件失敗しても他の添付・メモ本文の同期まで巻き込んで止めない。失敗したidはfailedAttachmentIdsに
  // 集めて後段のdirtyクリアから除外する（＝そのidのdirtyは1のまま残り、次回のrunSyncで再送される）
  const failedAttachmentIds = new Set<string>();
  for (const a of dirtyAtts) {
    // 削除済み添付は実体を再送しない。PUTするとサーバーのメタ行が「生存・現在時刻」で上書きされ、
    // 下のPOSTで送る削除tombstoneがLWWで負けて復活してしまう（2026-07-21 実バグ）。削除の伝搬はPOSTに任せる
    if (a.deleted === 1) continue;
    const rec = await db.attachmentBlobs.get(a.id);
    if (!rec) continue;
    try {
      const up = await fetchFn(`/api/attachments/${a.id}?noteId=${a.noteId}`, {
        method: "PUT",
        headers: { "Content-Type": a.mime, Authorization: `Bearer ${token}` },
        body: rec.blob,
      });
      if (!up.ok) throw new Error(`attachment upload failed: ${up.status}`);
    } catch {
      failedAttachmentIds.add(a.id);
    }
  }

  const selfEndpoint = await getSelfEndpoint();
  const res = await fetchFn("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      since,
      notes: dirtyNotes.map(stripNote),
      attachments: dirtyAtts.map(stripAtt),
      folders: dirtyFolders.map(stripFolder),
      selfEndpoint,
    }),
  });
  if (!res.ok) throw new Error(`sync failed: ${res.status}`);
  const data = (await res.json()) as SyncResponse;
  const folders = data.folders ?? [];

  await db.transaction("rw", db.notes, db.attachments, db.attachmentBlobs, db.folders, db.meta, async () => {
    // fetch応答待ちの間に新しい編集が入っている場合、その編集のdirtyを誤ってクリアしないよう、
    // 現在の行のupdatedAtがpushしたスナップショットと一致する場合だけdirtyを落とす。
    for (const n of dirtyNotes) {
      const cur = await db.notes.get(n.id);
      if (cur && cur.updatedAt === n.updatedAt) await db.notes.update(n.id, { dirty: 0 });
    }
    for (const a of dirtyAtts) {
      if (failedAttachmentIds.has(a.id)) continue; // アップロード失敗分は次回リトライのためdirtyを維持する
      const cur = await db.attachments.get(a.id);
      if (cur && cur.updatedAt === a.updatedAt) await db.attachments.update(a.id, { dirty: 0 });
    }
    for (const fl of dirtyFolders) {
      const cur = await db.folders.get(fl.id);
      if (cur && cur.updatedAt === fl.updatedAt) await db.folders.update(fl.id, { dirty: 0 });
    }
    // Fix1: 適用条件は厳密な">"ではなく">="にする。サーバー側upsertは">"のままなので早い者勝ちの
    // 一意な基準は保たれるが、クライアント側を">="にすることで「同一updatedAtだが内容が違う」状態
    // （例: Dexie v2アップグレードの不具合でupdatedAtを変えずにfolderIdだけローカルで書き換わった等）
    // でもサーバーの値を採用して収束させる。自分がpushした行のエコーバック（内容が同一）を
    // 再適用するだけなので無害
    for (const n of data.notes) {
      const cur = await db.notes.get(n.id);
      if (!cur || n.updatedAt >= cur.updatedAt)
        await db.notes.put({
          ...n,
          folderId: n.folderId ?? null,
          orderKey: n.orderKey ?? null,
          author: n.author ?? null,
          answered: n.answered ?? 0,
          dirty: 0,
        });
    }
    for (const a of data.attachments) {
      const cur = await db.attachments.get(a.id);
      if (!cur || a.updatedAt >= cur.updatedAt) await db.attachments.put({ ...a, dirty: 0 });
    }
    for (const fl of folders) {
      const cur = await db.folders.get(fl.id);
      if (!cur || fl.updatedAt >= cur.updatedAt) await db.folders.put({ ...fl, orderKey: fl.orderKey ?? null, dirty: 0 });
    }
    await db.meta.put({ key: "lastSync", value: data.now });
    if (full) await db.meta.put({ key: "fullResyncV4", value: 1 });

    // サーバーで既にpurge済みのidは、上のdirtyクリアや受信適用で幽霊行が
    // 残っていてもここで物理削除して上書きする（削除の伝達漏れ防止・Fix2）。
    for (const id of data.purgedIds ?? []) {
      await db.notes.delete(id);
      const childAtts = await db.attachments.where("noteId").equals(id).toArray();
      for (const child of childAtts) {
        await db.attachmentBlobs.delete(child.id);
        await db.attachmentBlobs.delete(thumbKey(child.id));
      }
      await db.attachments.where("noteId").equals(id).delete();
      await db.attachmentBlobs.delete(id);

      await db.attachmentBlobs.delete(thumbKey(id));
      await db.attachments.delete(id);
      await db.folders.delete(id);
    }
  });

  return {
    pushed: dirtyNotes.length + dirtyAtts.length + dirtyFolders.length,
    pulled: data.notes.length + data.attachments.length + folders.length,
    failedAttachments: failedAttachmentIds.size,
  };
}
