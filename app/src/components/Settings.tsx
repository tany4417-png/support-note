import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { collectDiagnostics, type Diagnostics } from "../lib/diagnostics";
import { disablePush, ensurePushSubscription, isPushEnabled, sendTestPush } from "../lib/push";
import { getUserName, setUserName } from "../lib/profile";
import { BackIcon, ExportIcon, TrashIcon } from "./icons";

// 診断パネルの表示・コピー用にテキスト整形する（コンポーネント専用の純関数のため単体テストは設けていない。
// 集計自体はlib/diagnostics.tsのcollectDiagnosticsでテスト済み）
function formatDiagnosticsText(d: Diagnostics): string {
  const lastSync = d.lastSync ? new Date(d.lastSync).toLocaleString("ja-JP") : "未同期";
  return [
    `バージョン: ${d.version}`,
    `最終同期: ${lastSync}`,
    `全量同期(fullResyncV4): ${d.fullResyncDone ? "実施済み" : "未実施"}`,
    `メモ: 総数${d.notes.total} / ゴミ箱${d.notes.trashCount} / dirty${d.notes.dirty}`,
    `フォルダ: 総数${d.folders.total} / dirty${d.folders.dirty}`,
    `添付: メタ${d.attachments.metaCount} / dirty${d.attachments.dirty} / ローカル実体${d.attachments.blobCount}`,
    `通知許可: ${d.notifyPermission}`,
    `通知購読: ${d.pushEnabled ? "有効" : "無効"}`,
  ].join("\n");
}

type Props = {
  syncBar: React.ReactNode;
  // 画面切替（list/note/settings/trash）のスライドインクラス（slide-in-left/right）。ルート要素(.screen)に直接付ける
  slideClass: string;
  token: string;
  onSave: (t: string) => void;
  onBack: () => void;
  onExport: () => void;
  onTrash: () => void;
};

export function Settings({ syncBar, slideClass, token, onSave, onBack, onExport, onTrash }: Props) {
  const [value, setValue] = useState(token);
  // 記名（メモに表示する投稿者名）。App側のstateを介さずprofile.tsを直接読み書きする（NameGateと同じ流儀）
  const [name, setName] = useState(() => getUserName() ?? "");
  const diagnostics = useLiveQuery(collectDiagnostics, [], null);
  const [pushOn, setPushOn] = useState(false);
  const [pushMsg, setPushMsg] = useState("");
  const [tokenCopied, setTokenCopied] = useState(false);

  useEffect(() => {
    isPushEnabled().then(setPushOn);
  }, []);

  // PCと端末とで表示中のビルドがずれる問題の再発防止。SWがあれば更新チェックしてから、
  // どちらにせよ1秒後にリロードする（SW未対応環境ではリロードのみ行う）
  async function updateApp() {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update()));
    }
    setTimeout(() => location.reload(), 1000);
  }

  return (
    <div className={`settings screen ${slideClass}`}>
      <div className="list-header">
        {syncBar}
        <div className="toolbar">
          <button className="icon-btn" onClick={onBack} aria-label="戻る">
            <BackIcon />
          </button>
          <h2>設定</h2>
        </div>
      </div>
      <div className="screen-body">
        {/* 内容が短くてもラバーバンドさせるため、中身全体を.bounce-areaで1枚ラップする（常にコンテナ＋1pxの高さ） */}
        <div className="bounce-area">
          <label htmlFor="token">APIトークン</label>
          <input id="token" type="password" value={value} onChange={(e) => setValue(e.target.value)} />
          <button className="primary" onClick={() => onSave(value.trim())}>保存</button>
          {/* 別端末へトークンを移すためのワンタップコピー。iOSはSafariとホーム画面アプリで保存領域が分かれ、
              パスワード欄からの選択コピーが弾かれやすいため、この画面から直接クリップボードへ渡せるようにする */}
          {token && (
            <button
              className="tint acc-blue"
              onClick={async () => {
                if (!navigator.clipboard) return;
                try {
                  await navigator.clipboard.writeText(token);
                  setTokenCopied(true);
                } catch {
                  setTokenCopied(false);
                }
              }}
            >
              トークンをコピー
            </button>
          )}
          {tokenCopied && <p>コピーしました。別の端末の設定に貼り付けてください</p>}
          <label htmlFor="userName">名前（メモに表示されます）</label>
          <input id="userName" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            className="primary"
            onClick={() => {
              const trimmed = name.trim();
              if (!trimmed) return;
              setUserName(trimmed);
              setName(trimmed);
            }}
          >
            保存
          </button>
          <hr />
          <button className="tint acc-teal" onClick={onExport}>
            <ExportIcon size={18} />
            全メモをエクスポート（zip）
          </button>
          <button onClick={onTrash}>
            <TrashIcon size={18} />
            ゴミ箱
          </button>
          <label>
            <input
              type="checkbox"
              checked={pushOn}
              onChange={async (e) => {
                if (e.target.checked) {
                  try {
                    const r = await ensurePushSubscription(token);
                    setPushOn(r === "subscribed");
                    setPushMsg(
                      r === "denied"
                        ? "通知が許可されていません。端末の設定から許可してください"
                        : r === "unsupported"
                          ? "この環境は通知に対応していません（iPhoneはホーム画面に追加したアプリから開いてください）"
                          : ""
                    );
                  } catch {
                    setPushOn(false);
                    setPushMsg("通知の設定に失敗しました。通信環境を確認してください");
                  }
                } else {
                  await disablePush(token);
                  setPushOn(false);
                  setPushMsg("");
                }
              }}
            />
            この端末で通知を受け取る
          </label>
          {pushMsg && <p>{pushMsg}</p>}
          {pushOn && (
            <button onClick={async () => setPushMsg((await sendTestPush(token)) ? "テスト通知を送りました" : "送信に失敗しました")}>
              テスト通知
            </button>
          )}
          <hr />
          <p>バージョン: {__APP_VERSION__}</p>
          <button className="tint acc-blue" onClick={() => void updateApp()}>
            アプリを更新
          </button>
          <hr />
          <details className="diag">
            <summary>同期の診断</summary>
            {diagnostics && (
              <div className="diag-body">
                <p>バージョン: {diagnostics.version}</p>
                <p>最終同期: {diagnostics.lastSync ? new Date(diagnostics.lastSync).toLocaleString("ja-JP") : "未同期"}</p>
                <p>全量同期(fullResyncV4): {diagnostics.fullResyncDone ? "実施済み" : "未実施"}</p>
                <p>メモ: 総数{diagnostics.notes.total} / ゴミ箱{diagnostics.notes.trashCount} / dirty{diagnostics.notes.dirty}</p>
                <p>フォルダ: 総数{diagnostics.folders.total} / dirty{diagnostics.folders.dirty}</p>
                <p>
                  添付: メタ{diagnostics.attachments.metaCount} / dirty{diagnostics.attachments.dirty} / ローカル実体
                  {diagnostics.attachments.blobCount}
                </p>
                <p>通知許可: {diagnostics.notifyPermission}</p>
                <p>通知購読: {diagnostics.pushEnabled ? "有効" : "無効"}</p>
                <button
                  className="tint acc-teal"
                  onClick={() => void navigator.clipboard.writeText(formatDiagnosticsText(diagnostics))}
                >
                  診断情報をコピー
                </button>
              </div>
            )}
          </details>
        </div>
      </div>
    </div>
  );
}
