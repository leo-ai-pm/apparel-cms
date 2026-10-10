"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

export type LocalPersonalPhoto = { file: File; url: string };
type Scope = { resetKey: string; enabled: boolean };
type Selection = { scope: Scope; generation: number; photo: LocalPersonalPhoto | null; error: string };
type Lifecycle = { scope: Scope; generation: number; url: string | null };
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Local input convenience checks only; this does not validate or upload an image to a server. */
export function useLocalPersonalPhoto(resetKey: string, enabled: boolean): {
  photo: LocalPersonalPhoto | null;
  error: string;
  select: (file: File) => void;
  clear: () => void;
} {
  // A -> B -> A and enabled -> disabled -> enabled create different lifetimes,
  // so neither an old preview nor a delayed selection can return with the same key.
  const scope = useMemo<Scope>(() => ({ resetKey, enabled }), [resetKey, enabled]);
  const [selection, setSelection] = useState<Selection>(() => ({ scope, generation: 0, photo: null, error: "" }));
  const lifecycle = useRef<Lifecycle | null>(null);
  const generation = selection.scope === scope ? selection.generation : 0;
  // Clear the retained File together with the rendered preview at an identity
  // boundary. This guarded render adjustment does not wait for an effect.
  if (selection.scope !== scope) {
    setSelection({ scope, generation: 0, photo: null, error: "" });
  }

  function release(owner: Lifecycle) {
    const url = owner.url;
    owner.url = null;
    if (url) URL.revokeObjectURL(url);
  }

  useLayoutEffect(() => {
    const owner: Lifecycle = { scope, generation: 0, url: null };
    lifecycle.current = owner;
    return () => {
      release(owner);
      if (lifecycle.current === owner) lifecycle.current = null;
    };
  }, [scope]);

  function current(): Lifecycle | null {
    const owner = lifecycle.current;
    return enabled && owner?.scope === scope && owner.generation === generation ? owner : null;
  }

  function select(file: File) {
    const owner = current();
    if (!owner) return;
    // Clear the prior selection even when the new file is invalid, so its image
    // cannot be mistaken for the file that the user has just tried to choose.
    owner.generation += 1;
    release(owner);
    let error = "";
    let photo: LocalPersonalPhoto | null = null;
    if (!(file instanceof File) || !SUPPORTED_TYPES.has(file.type)) {
      error = "请选择 JPEG、PNG 或 WebP 照片；HEIC 等格式请先转换。";
    } else if (file.size === 0) {
      error = "照片文件为空，请重新选择。";
    } else if (file.size > MAX_PHOTO_BYTES) {
      error = "照片超过本地选择上限 5 MiB，请压缩后重新选择。";
    } else {
      try {
        const url = URL.createObjectURL(file);
        owner.url = url;
        photo = { file, url };
      } catch {
        error = "本地照片预览暂时无法创建，请重新选择。";
      }
    }
    setSelection({ scope, generation: owner.generation, photo, error });
  }

  function clear() {
    const owner = current();
    if (!owner) return;
    owner.generation += 1;
    release(owner);
    setSelection({ scope, generation: owner.generation, photo: null, error: "" });
  }

  const visible = enabled && selection.scope === scope;
  return { photo: visible ? selection.photo : null, error: visible ? selection.error : "", select, clear };
}
