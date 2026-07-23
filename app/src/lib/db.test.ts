import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { migrateNotesFolderId } from "./db";

// 実際に出荷されるアップグレード関数（db.tsからimport）をそのまま使う。
// テスト側で同じロジックを書き写すと実装とテストが別々に乖離し得るため、
// 常に本物のmigrateNotesFolderIdを検証する
function openV2(name: string) {
  const v2 = new Dexie(name);
  v2.version(1).stores({
    notes: "id, updatedAt, createdAt, importance, dirty",
    attachments: "id, noteId, updatedAt, dirty",
    attachmentBlobs: "id",
    meta: "key",
  });
  v2.version(2)
    .stores({
      notes: "id, updatedAt, createdAt, importance, dirty, folderId",
      attachments: "id, noteId, updatedAt, dirty",
      attachmentBlobs: "id",
      meta: "key",
      folders: "id, parentId, updatedAt, dirty",
    })
    .upgrade(migrateNotesFolderId);
  return v2;
}

describe("Dexie version(2) アップグレード", () => {
  it("既存のv1 notesレコードを保持したままfolderId=nullを付与する", async () => {
    const name = "supportnote-upgrade-test";
    await Dexie.delete(name);

    const v1 = new Dexie(name);
    v1.version(1).stores({
      notes: "id, updatedAt, createdAt, importance, dirty",
      attachments: "id, noteId, updatedAt, dirty",
      attachmentBlobs: "id",
      meta: "key",
    });
    await v1.open();
    await v1.table("notes").put({
      id: "OLD1",
      body: "既存メモ",
      importance: 1,
      createdAt: 1,
      updatedAt: 2,
      deleted: 0,
      dirty: 1,
    });
    v1.close();

    const v2 = openV2(name);
    await v2.open();

    const migrated = await v2.table("notes").get("OLD1");
    expect(migrated).toBeDefined();
    expect(migrated.body).toBe("既存メモ");
    expect(migrated.folderId).toBeNull();
    v2.close();

    await Dexie.delete(name);
  });

  it("既にfolderIdを持つv1行は上書きしない（Fix1: サーバーとの膠着防止・恒久修正）", async () => {
    // 実害の再現: v1スキーマはfolderIdを宣言していないが、同期で受信済みの行には
    // 既にfolderIdの実データが入っていることがある。以前は modify({ folderId: null })
    // が無条件適用され、updatedAtは変えないままこの実データをnullで踏みつぶし、
    // サーバーと「同時刻・別内容」の膠着を引き起こしていた
    const name = "supportnote-upgrade-test-2";
    await Dexie.delete(name);

    const v1 = new Dexie(name);
    v1.version(1).stores({
      notes: "id, updatedAt, createdAt, importance, dirty",
      attachments: "id, noteId, updatedAt, dirty",
      attachmentBlobs: "id",
      meta: "key",
    });
    await v1.open();
    await v1.table("notes").put({
      id: "OLD2",
      body: "フォルダ済みメモ",
      importance: 0,
      createdAt: 1,
      updatedAt: 2,
      deleted: 0,
      dirty: 0,
      folderId: "FOLDER-X", // 同期で既に受信済みの実データ（v1スキーマ上は宣言外だが値は存在する）
    });
    v1.close();

    const v2 = openV2(name);
    await v2.open();

    const migrated = await v2.table("notes").get("OLD2");
    expect(migrated).toBeDefined();
    expect(migrated.folderId).toBe("FOLDER-X");
    expect(migrated.updatedAt).toBe(2);
    v2.close();

    await Dexie.delete(name);
  });
});
