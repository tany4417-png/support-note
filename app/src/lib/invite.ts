// 招待リンク（#setup=トークン）の適用と、SafariとホームPWA間のトークン引き継ぎ。
// iOSは「ホーム画面に追加」したPWAとSafariで保存領域が別々になり、localStorageは
// 引き継がれない。両者で共有されるCache Storageにも書いておき、PWA初回起動時に
// localStorageが空ならCacheから引き継ぐ。
const TOKEN_KEY = "supportnote.token";
const CACHE_NAME = "supportnote-invite";
const CACHE_URL = "/__invite-token";

export function parseSetupHash(hash: string): string | null {
  if (!hash.startsWith("#setup=")) return null;
  const raw = hash.slice("#setup=".length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function writeTokenToCache(token: string): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(CACHE_URL, new Response(token));
  } catch {
    // Cacheに書けなくてもlocalStorage側で動作は成立する（プライベートモード等）
  }
}

async function readTokenFromCache(): Promise<string | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(CACHE_URL);
    if (!res) return null;
    const text = await res.text();
    return text || null;
  } catch {
    return null;
  }
}

// 戻り値は保存の成否。localStorageに書けない環境（プライベートブラウズ等）を
// 無音で成功扱いにしないため、呼び出し側で失敗を通知できるようにする
export async function saveToken(token: string): Promise<boolean> {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    return false;
  }
  await writeTokenToCache(token);
  return true;
}

function stripSetupHash(): void {
  history.replaceState(null, "", location.pathname + location.search);
}

// 開きっぱなしのタブで招待リンクを踏むと、ハッシュだけの変化は再読み込みにならず
// ブート処理が走らない（Safariのタブ再利用で現実に起こる）。hashchangeで検知して
// リロードし、applyInviteOnBootの通常経路に乗せる
export function watchInviteHash(reload: () => void = () => location.reload()): () => void {
  const onHashChange = () => {
    if (parseSetupHash(location.hash)) reload();
  };
  window.addEventListener("hashchange", onHashChange);
  return () => window.removeEventListener("hashchange", onHashChange);
}

// 起動時（Reactレンダー前）に1回呼ぶ。優先順位は 招待リンク > localStorage > Cache
export async function applyInviteOnBoot(opts: {
  confirmOverwrite: (current: string) => boolean;
}): Promise<"applied" | "kept" | "none" | "failed"> {
  const linkToken = parseSetupHash(location.hash);
  const current = localStorage.getItem(TOKEN_KEY);

  if (linkToken) {
    stripSetupHash();
    if (current && current !== linkToken && !opts.confirmOverwrite(current)) {
      return "kept";
    }
    return (await saveToken(linkToken)) ? "applied" : "failed";
  }

  if (!current) {
    const cached = await readTokenFromCache();
    if (cached) {
      // ここの失敗は通知しない（ユーザー操作起点でなく、次回起動時に再試行されるため）
      try {
        localStorage.setItem(TOKEN_KEY, cached);
      } catch {
        return "none";
      }
      return "applied";
    }
  }
  return "none";
}
