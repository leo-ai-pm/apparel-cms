"use client";

import Image, { type ImageProps } from "next/image";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject, type ReactNode } from "react";
import { ConsumerEventRecorder, type ConsumerEventInput, type ConsumerEventRecord, type ConsumerPage } from "@/app/lib/consumer-events";

export type ConsumerEventController = {
  sessionId: string;
  page: ConsumerPage;
  active: boolean;
  pageViewId: string;
  failures: readonly ConsumerEventRecord[];
  pendingCount: number;
  emit: ConsumerEventRecorder["emit"];
  retry: ConsumerEventRecorder["retry"];
  retryAll: ConsumerEventRecorder["retryAll"];
};
const ConsumerEventsContext = createContext<ConsumerEventController | null>(null);

export function useConsumerEventSession(sessionId: string, page: ConsumerPage, active = true): ConsumerEventController {
  const recorder = useMemo(() => new ConsumerEventRecorder(sessionId), [sessionId]);
  const snapshot = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, recorder.getSnapshot);
  useEffect(() => { recorder.enterPage(page, active); }, [recorder, page, active]);
  return useMemo(() => ({ sessionId, page, active, pageViewId: snapshot.pageViewId,
    failures: snapshot.records.filter(record => record.status === "failed"),
    pendingCount: snapshot.records.filter(record => record.status === "pending").length,
    emit: recorder.emit, retry: recorder.retry, retryAll: recorder.retryAll,
  }), [sessionId, page, active, snapshot, recorder]);
}

export function ConsumerEventsProvider({ value, children }: { value: ConsumerEventController; children: ReactNode }) {
  return <ConsumerEventsContext.Provider value={value}>{children}</ConsumerEventsContext.Provider>;
}
export const useConsumerEvents = () => useContext(ConsumerEventsContext);

export function ConsumerEventNotice({ controller }: { controller: ConsumerEventController }) {
  if (!controller.failures.length) return null;
  return <div role="status" aria-live="polite" data-consumer-event-status="failed">
    <span>有 {controller.failures.length} 条浏览记录未保存，不影响继续搭配。{controller.failures.some(row => row.error?.includes("冲突")) ? "存在记录编号冲突，原记录已保留。" : ""}</span>{" "}
    <button type="button" onClick={controller.retryAll}>重试保存浏览记录</button>
  </div>;
}

type ExposureOptions = {
  imageLoaded: boolean;
  event: ConsumerEventInput;
  active?: boolean;
  dwellMs?: number;
  minimumFraction?: number;
};

/** Continuous real visibility; cached images still require a successful decode and an observed viewport. */
export function useConsumerExposure<T extends HTMLElement>(ref: RefObject<T | null>, { imageLoaded, event, active = true, dwellMs = 1000, minimumFraction = .5 }: ExposureOptions) {
  const controller = useConsumerEvents();
  const eventKey = JSON.stringify(event);
  const stableEvent = useMemo(() => JSON.parse(eventKey) as ConsumerEventInput, [eventKey]);
  const emit = controller?.emit;
  const pageViewId = controller?.pageViewId;
  const enabled = controller?.active === true && active && imageLoaded;
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !emit || !pageViewId || !element || typeof IntersectionObserver === "undefined") return;
    let ratio = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = 0;
    let sent = false;
    let disposed = false;
    let suspended = false;
    const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; started = 0; };
    const displayed = () => {
      if (disposed || suspended || document.visibilityState === "hidden" || element.closest("[hidden],[inert]")) return false;
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && ratio >= minimumFraction;
    };
    const update = () => {
      if (sent || !displayed()) { cancel(); return; }
      if (timer !== undefined) return;
      started = performance.now();
      timer = setTimeout(() => {
        timer = undefined;
        if (!displayed()) { cancel(); return; }
        const dwell = Math.max(dwellMs, Math.floor(performance.now() - started));
        const observation: ConsumerEventInput = { ...stableEvent, image_loaded: true };
        if (observation.event_name === "product_impression") { observation.visible_fraction = ratio; observation.dwell_ms = dwell; }
        if (observation.event_name === "outfit_displayed") observation.canvas_visible = true;
        const key = `exposure:${observation.event_name}:${observation.source_slot}:${observation.product_id ?? observation.look_version_id ?? ""}`;
        sent = emit(observation, key) !== null;
      }, dwellMs);
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.target === element) ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
      update();
    }, { threshold: [0, minimumFraction, 1] });
    const hidePage = () => { suspended = true; cancel(); };
    const showPage = () => { suspended = false; update(); };
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pagehide", hidePage);
    window.addEventListener("pageshow", showPage);
    return () => { disposed = true; cancel(); observer.disconnect(); document.removeEventListener("visibilitychange", update); window.removeEventListener("pagehide", hidePage); window.removeEventListener("pageshow", showPage); };
  }, [ref, enabled, emit, pageViewId, stableEvent, minimumFraction, dwellMs]);
}

/** Adds observation without wrappers, changing image geometry, or replacing existing load/error handling. */
export function ConsumerObservedImage({ observation, observationActive = true, minimumFraction, dwellMs, onLoad, onError, ...props }: ImageProps & {
  observation: ConsumerEventInput;
  observationActive?: boolean;
  minimumFraction?: number;
  dwellMs?: number;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const sourceKey = typeof props.src === "string" ? props.src : JSON.stringify(props.src);
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  useEffect(() => {
    const image = ref.current;
    if (image?.complete && image.naturalWidth > 0) setLoadedSource(sourceKey);
  }, [sourceKey]);
  useConsumerExposure(ref, { imageLoaded: loadedSource === sourceKey, event: observation, active: observationActive, minimumFraction, dwellMs });
  return <Image {...props} alt={props.alt} ref={ref} onLoad={event => { if (event.currentTarget.naturalWidth > 0) setLoadedSource(sourceKey); onLoad?.(event); }}
    onError={event => { setLoadedSource(null); onError?.(event); }} />;
}
