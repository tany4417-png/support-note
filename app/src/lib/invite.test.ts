// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyInviteOnBoot, parseSetupHash, saveToken, watchInviteHash } from "./invite";

const TOKEN_KEY = "supportnote.token";
const CACHE_NAME = "supportnote-invite";
const CACHE_URL = "/__invite-token";

// jsdomにCache APIが無いため、Map実装の代替を差す。
// iOSでSafariとホーム画面PWAの間で共有されるのはCache Storageだけなので、
// 「localStorageとCacheの二重保存」がこのモジュールの本質になる
function makeFakeCaches() {
  const stores = new Map<string, Map<string, string>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      put: async (url: string, res: Response) => {
        store.set(url, await res.text());
      },
      match: async (url: string) => (store.has(url) ? new Response(store.get(url)!) : undefined),
    };
  };
  return { caches: { open } as unknown as CacheStorage, stores };
}

async function cachedToken(fake: ReturnType<typeof makeFakeCaches>): Promise<string | null> {
  const cache = await fake.caches.open(CACHE_NAME);
  const res = await cache.match(CACHE_URL);
  return res ? await res.text() : null;
}

let fake: ReturnType<typeof makeFakeCaches>;

beforeEach(() => {
  localStorage.clear();
  location.hash = "";
  fake = makeFakeCaches();
  (globalThis as { caches?: CacheStorage }).caches = fake.caches;
});

afterEach(() => {
  delete (globalThis as { caches?: CacheStorage }).caches;
});

describe("parseSetupHash", () => {
  it("#setup=トークン からトークンを取り出す", () => {
    expect(parseSetupHash("#setup=abc123")).toBe("abc123");
  });

  it("setup以外のハッシュ・空文字はnull", () => {
    expect(parseSetupHash("")).toBeNull();
    expect(parseSetupHash("#foo")).toBeNull();
    expect(parseSetupHash("#setup=")).toBeNull();
  });

  it("URLエンコードされたトークンを復号する", () => {
    expect(parseSetupHash("#setup=a%2Bb%3D")).toBe("a+b=");
  });
});

describe("applyInviteOnBoot", () => {
  it("新規端末: ハッシュのトークンをlocalStorageとCacheに保存しハッシュを消す", async () => {
    location.hash = "#setup=tok1";
    const result = await applyInviteOnBoot({ confirmOverwrite: () => true });
    expect(result).toBe("applied");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok1");
    expect(await cachedToken(fake)).toBe("tok1");
    expect(location.hash).toBe("");
  });

  it("既存と同じトークンのリンクは確認なしで受け入れる", async () => {
    localStorage.setItem(TOKEN_KEY, "tok1");
    location.hash = "#setup=tok1";
    const confirmOverwrite = vi.fn(() => false);
    const result = await applyInviteOnBoot({ confirmOverwrite });
    expect(result).toBe("applied");
    expect(confirmOverwrite).not.toHaveBeenCalled();
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok1");
    expect(location.hash).toBe("");
  });

  it("既存と異なるトークンは確認OKで上書きする", async () => {
    localStorage.setItem(TOKEN_KEY, "old");
    location.hash = "#setup=new";
    const result = await applyInviteOnBoot({ confirmOverwrite: () => true });
    expect(result).toBe("applied");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("new");
    expect(await cachedToken(fake)).toBe("new");
  });

  it("既存と異なるトークンは確認キャンセルで既存を守る（ハッシュは消す）", async () => {
    localStorage.setItem(TOKEN_KEY, "old");
    location.hash = "#setup=new";
    const result = await applyInviteOnBoot({ confirmOverwrite: () => false });
    expect(result).toBe("kept");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("old");
    expect(await cachedToken(fake)).toBeNull();
    expect(location.hash).toBe("");
  });

  it("ハッシュ無し・localStorage空ならCacheから引き継ぐ（PWAインストール直後の初回起動）", async () => {
    const cache = await fake.caches.open(CACHE_NAME);
    await cache.put(CACHE_URL, new Response("tok-from-safari"));
    const result = await applyInviteOnBoot({ confirmOverwrite: () => true });
    expect(result).toBe("applied");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok-from-safari");
  });

  it("ハッシュ無し・localStorage設定済みならCacheより既存を優先する", async () => {
    localStorage.setItem(TOKEN_KEY, "mine");
    const cache = await fake.caches.open(CACHE_NAME);
    await cache.put(CACHE_URL, new Response("other"));
    const result = await applyInviteOnBoot({ confirmOverwrite: () => true });
    expect(result).toBe("none");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("mine");
  });

  it("ハッシュもCacheも無ければ何もしない", async () => {
    const result = await applyInviteOnBoot({ confirmOverwrite: () => true });
    expect(result).toBe("none");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("Cache API非対応でもハッシュのトークンはlocalStorageに入る", async () => {
    delete (globalThis as { caches?: CacheStorage }).caches;
    location.hash = "#setup=tok1";
    const result = await applyInviteOnBoot({ confirmOverwrite: () => true });
    expect(result).toBe("applied");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok1");
  });

  it("リンクのトークンを保存できなかったらfailedを返す（呼び出し側でユーザーに知らせるため）", async () => {
    location.hash = "#setup=tok1";
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      const result = await applyInviteOnBoot({ confirmOverwrite: () => true });
      expect(result).toBe("failed");
      expect(location.hash).toBe("");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("watchInviteHash", () => {
  it("起動後に#setup=ハッシュが現れたらリロードする（開きっぱなしのタブで招待リンクを踏んだ場合）", () => {
    const reload = vi.fn();
    const stop = watchInviteHash(reload);
    location.hash = "#setup=tok1";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it("setup以外のハッシュ変化ではリロードしない", () => {
    const reload = vi.fn();
    const stop = watchInviteHash(reload);
    location.hash = "#other";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(reload).not.toHaveBeenCalled();
    stop();
  });
});

describe("saveToken", () => {
  it("localStorageとCacheの両方に保存してtrueを返す（設定画面の手入力でも共有が効くように）", async () => {
    await expect(saveToken("manual-token")).resolves.toBe(true);
    expect(localStorage.getItem(TOKEN_KEY)).toBe("manual-token");
    expect(await cachedToken(fake)).toBe("manual-token");
  });

  it("Cache API非対応でも例外を出さずlocalStorageへ保存してtrueを返す", async () => {
    delete (globalThis as { caches?: CacheStorage }).caches;
    await expect(saveToken("t")).resolves.toBe(true);
    expect(localStorage.getItem(TOKEN_KEY)).toBe("t");
  });

  it("localStorageに書けないときはfalseを返す（プライベートブラウズ等。無音で成功扱いにしない）", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      await expect(saveToken("t")).resolves.toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
