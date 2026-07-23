// 記名（メモに表示する投稿者名）の端末ローカル保存。招待トークン（invite.ts）と同じlocalStorage方式
const NAME_KEY = "supportnote.name";

// typeof判定はNode実行のテスト（jsdom未指定のlib配下テスト）でlocalStorage未定義のままcreateNoteが
// 例外を出さないための防御。実ブラウザでは常にlocalStorageが存在するため通常は素通りする
export function getUserName(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(NAME_KEY);
}

export function setUserName(name: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(NAME_KEY, name);
}
