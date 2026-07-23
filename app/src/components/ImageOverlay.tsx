import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getImageBlob } from "../lib/attachments";
import { downloadUrlSpec } from "../lib/dragout";
import { mimeToExt } from "../lib/export";
import type { AttachmentMeta } from "../lib/types";
import { clampPan, DOUBLE_TAP_SCALE, pinchScale, zoomAt, type ZoomState } from "../lib/zoom";
import { CloseIcon } from "./icons";

// タップ判定: 押下からこの距離・時間を超えたらタップ扱いしない（パン・ピンチと区別する）
const TAP_SLOP_PX = 8;
const TAP_MS = 300;
// この間隔・距離内の2回目のタップをダブルタップとして等倍⇔拡大を切り替える
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP_PX = 40;

// 画像の原寸表示。body直下へポータルで描画する（バックスワイプのキャンセルで.screenに
// transformが残るとfixedの基準がすり替わり、上端がヘッダー分見切れるため）。
// ズーム操作: ピンチ（1〜4倍・指の中心基準）／拡大中は1本指ドラッグで移動／画像ダブルタップで
// 2.5倍⇔等倍／PCはホイール。閉じるのは背景タップか✕ボタン（画像タップでは閉じない。
// ピンチ・パンと誤爆するため2026-07-21に仕様変更）
export function ImageOverlay({
  att,
  onClose,
  onDelete,
}: {
  att: AttachmentMeta;
  onClose: () => void;
  onDelete?: (attId: string) => void;
}) {
  const fullUrl = useFullImageUrl(att.id);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // ズーム状態はrefに持ち、pointermoveのたびにstyleへ直接書く（バックスワイプ追従と同じ流儀。
  // Reactのstateを介すと高頻度な再レンダーになるため）。zoomedだけは表示制御用のstateミラー
  const zoom = useRef<ZoomState>({ scale: 1, tx: 0, ty: 0 });
  const [zoomed, setZoomed] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ startDist: number; startScale: number } | null>(null);
  const down = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);
  const lastTap = useRef<{ x: number; y: number; t: number } | null>(null);

  function apply(next: ZoomState) {
    const img = imgRef.current;
    const box = boxRef.current;
    if (!img || !box) return;
    // offsetWidth/Heightはtransformの影響を受けないレイアウトサイズ＝scale1の基準サイズ
    const clamped = clampPan(next, img.offsetWidth, img.offsetHeight, box.clientWidth, box.clientHeight);
    zoom.current = clamped;
    img.style.transform = `translate3d(${clamped.tx}px, ${clamped.ty}px, 0) scale(${clamped.scale})`;
    setZoomed(clamped.scale > 1);
  }

  // クライアント座標→コンテナ中心基準（zoom.tsの座標系）
  function toCenter(cx: number, cy: number): { x: number; y: number } {
    const b = boxRef.current?.getBoundingClientRect();
    if (!b) return { x: 0, y: 0 };
    return { x: cx - b.left - b.width / 2, y: cy - b.top - b.height / 2 };
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // ✕・削除ボタン上はジェスチャー扱いしない（クリックに任せる）
    if ((e.target as HTMLElement).closest("button")) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      down.current = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { startDist: Math.hypot(a.x - b.x, a.y - b.y), startScale: zoom.current.scale };
      down.current = null; // 2本目が触れた時点でタップ判定は破棄
    }
    // マウスはcaptureしない（scale1のときのimgドラッグアウト＝HTML5 dragを邪魔しないため）。
    // タッチだけcaptureして、指がコンテナ外へ出ても追従を切らさない
    if (e.pointerType === "touch") {
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // captureできない環境でも追従自体は継続する
      }
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = down.current;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP_PX) d.moved = true;
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = toCenter((a.x + b.x) / 2, (a.y + b.y) / 2);
      const s = pinchScale(pinch.current.startScale, pinch.current.startDist, Math.hypot(a.x - b.x, a.y - b.y));
      apply(zoomAt(zoom.current, mid.x, mid.y, s));
      return;
    }
    if (pointers.current.size === 1 && zoom.current.scale > 1) {
      apply({ ...zoom.current, tx: zoom.current.tx + (e.clientX - prev.x), ty: zoom.current.ty + (e.clientY - prev.y) });
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const had = pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!had) return;
    const d = down.current;
    down.current = null;
    if (!d || d.moved || Date.now() - d.t > TAP_MS) {
      lastTap.current = null;
      return;
    }
    // タップ確定。ダブルタップ（画像上・背景とも）なら拡大切替、背景シングルタップなら閉じる
    const last = lastTap.current;
    const now = Date.now();
    if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_SLOP_PX) {
      lastTap.current = null;
      const p = toCenter(e.clientX, e.clientY);
      apply(zoom.current.scale > 1 ? { scale: 1, tx: 0, ty: 0 } : zoomAt(zoom.current, p.x, p.y, DOUBLE_TAP_SCALE));
      return;
    }
    lastTap.current = { x: e.clientX, y: e.clientY, t: now };
    if (e.target === boxRef.current) onClose();
  }

  function onPointerCancel(e: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    down.current = null;
  }

  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    const p = toCenter(e.clientX, e.clientY);
    apply(zoomAt(zoom.current, p.x, p.y, zoom.current.scale * (e.deltaY < 0 ? 1.25 : 0.8)));
  }

  if (!fullUrl) return null;
  return createPortal(
    <div
      ref={boxRef}
      className="overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onWheel={onWheel}
    >
      <img
        ref={imgRef}
        src={fullUrl}
        // 等倍のときだけOSへのドラッグアウトを有効にする（拡大中は1本指ドラッグ＝移動と衝突するため）
        draggable={!zoomed}
        onDragStart={(e) => onImageDragStart(e, att, fullUrl)}
        alt=""
      />
      <button className="overlay-close" aria-label="閉じる" onClick={onClose}>
        <CloseIcon size={18} />
      </button>
      {onDelete && (
        <button
          className="danger overlay-delete"
          onClick={() => {
            onClose();
            onDelete(att.id);
          }}
        >
          この画像を削除
        </button>
      )}
    </div>,
    document.body
  );
}

// ギャラリー画像のdragstart（同期処理）。ChromiumのDownloadURL形式でOS側へファイル生成の手がかりを渡す。
// fullUrl未取得（オフライン等）のときは何もしない（draggable={false}にしているので通常はここへ来ない）
export function onImageDragStart(e: React.DragEvent<HTMLImageElement>, att: AttachmentMeta, fullUrl: string | undefined): void {
  if (!fullUrl) return;
  const filename = `サポートノート-画像-${att.id.slice(-6)}.${mimeToExt(att.mime)}`;
  e.dataTransfer.setData("DownloadURL", downloadUrlSpec(att.mime, filename, fullUrl));
  e.dataTransfer.setData("text/uri-list", fullUrl);
  e.dataTransfer.effectAllowed = "copy";
}

// 原寸オーバーレイ表示中だけ、対象1件の本体blobを取りに行く（サムネと違い全件を先読みしない）
function useFullImageUrl(id: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) {
      setUrl(null);
      return;
    }
    let alive = true;
    let created: string | null = null;
    void (async () => {
      const token = localStorage.getItem("supportnote.token") ?? "";
      const blob = await getImageBlob(id, token);
      if (alive && blob) {
        created = URL.createObjectURL(blob);
        setUrl(created);
      }
    })();
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [id]);
  return url;
}
