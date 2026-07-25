import { ulid } from "ulid";
import { db } from "./db";

// 端末の識別子。通知の購読とは独立に必ず存在する値で、編集中の申告が誰のものかの
// 判定に使う（購読endpointは通知をオンにしていない端末でnullになるため使えない）
export async function getClientId(): Promise<string> {
  const saved = await db.meta.get("clientId");
  if (typeof saved?.value === "string" && saved.value !== "") return saved.value;
  const id = ulid();
  await db.meta.put({ key: "clientId", value: id });
  return id;
}
