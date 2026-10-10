"use client";

import { useEffect, type RefObject } from "react";

/** Keep pointer work outside React rendering; CSS owns the independent float loops. */
export function useHeroMotion(ref: RefObject<HTMLDivElement | null>, active: boolean, paused: boolean) {
  useEffect(() => {
    const stage = ref.current;
    if (!stage) return;
    stage.dataset.motionMode = "static";
    if (!active || typeof window.matchMedia !== "function") return;

    const motion = window.matchMedia("(min-width: 901px) and (prefers-reduced-motion: no-preference)");
    const pointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    let visible = true;
    let focused = !!stage.querySelector("[data-hero-sku] button:focus-visible");
    let frame = 0;
    let x = 0;
    let y = 0;
    let targetX = 0;
    let targetY = 0;
    let lastTime = 0;

    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0; lastTime = 0;
      x = y = targetX = targetY = 0;
      stage.style.setProperty("--pointer-x", "0px");
      stage.style.setProperty("--pointer-y", "0px");
    };
    const running = () => stage.dataset.motionMode === "running" && pointer.matches && !focused;
    const tick = (time: number) => {
      frame = 0;
      if (!running()) return;
      const delta = lastTime ? Math.min(time - lastTime, 48) : 16;
      lastTime = time;
      const blend = 1 - Math.exp(-delta / 100);
      x += (targetX - x) * blend;
      y += (targetY - y) * blend;
      const settled = Math.abs(targetX - x) + Math.abs(targetY - y) < .025;
      if (settled) { x = targetX; y = targetY; }
      stage.style.setProperty("--pointer-x", `${x.toFixed(3)}px`);
      stage.style.setProperty("--pointer-y", `${y.toFixed(3)}px`);
      if (!settled) frame = requestAnimationFrame(tick);
      else lastTime = 0;
    };
    const schedule = () => { if (!frame && running()) frame = requestAnimationFrame(tick); };
    const update = () => {
      stage.dataset.motionMode = !motion.matches ? "static" : paused || !visible || document.hidden ? "paused" : "running";
      if (!running()) reset();
    };
    const move = (event: PointerEvent) => {
      if (!running() || event.pointerType === "touch") return;
      const bounds = stage.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      targetX = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1)) * 10;
      targetY = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1)) * 6;
      schedule();
    };
    const leave = () => { targetX = targetY = 0; schedule(); };
    const focus = () => {
      focused = !!stage.querySelector("[data-hero-sku] button:focus-visible");
      if (focused) reset();
    };
    const blur = (event: FocusEvent) => {
      if (!stage.contains(event.relatedTarget as Node | null)) focused = false;
    };
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      update();
    }) : null;
    observer?.observe(stage);
    motion.addEventListener("change", update);
    pointer.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerleave", leave);
    stage.addEventListener("focusin", focus);
    stage.addEventListener("focusout", blur);
    update();
    return () => {
      observer?.disconnect();
      motion.removeEventListener("change", update);
      pointer.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerleave", leave);
      stage.removeEventListener("focusin", focus);
      stage.removeEventListener("focusout", blur);
      reset();
      stage.dataset.motionMode = "static";
    };
  }, [ref, active, paused]);
}
