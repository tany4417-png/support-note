import { useState } from "react";
import { setUserName } from "../lib/profile";

type Props = {
  onDone: () => void;
};

// 起動時、名前未設定の端末に全画面で表示するゲート（App.tsx側でgetUserName()がnullの間だけ描画する）。
// 保存でsetUserNameへ書き込み、onDoneを呼んで通常UIへ戻す
export function NameGate({ onDone }: Props) {
  const [value, setValue] = useState("");

  const save = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setUserName(trimmed);
    onDone();
  };

  return (
    <div className="name-gate">
      <h2>サポートノート</h2>
      <p>メモに表示する名前を入力してください</p>
      <input
        aria-label="名前"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
        autoFocus
      />
      <button className="primary" onClick={save}>保存</button>
    </div>
  );
}
