import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "zhixu-handoff-"));
  vi.stubEnv("WORKBENCH_CASES_DB", path.join(directory, "cases.sqlite"));
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe("direct product-to-design handoff", () => {
  it("preserves approved versions and returns design feedback idempotently", async () => {
    const { buildApprovedPackage } = await import("@/lib/direct-handoff");
    const { saveCase, listApprovedPackages, saveDesignEvent, listDesignEvents } = await import("@/lib/workbench-cases");
    const signal = { signal_id: "SIG-20261009-0001", scene: "commute", feedback_type: "intent", preference: "直筒长裤" };
    const first = buildApprovedPackage(signal, "改善通勤裤长");
    saveCase(signal.signal_id, "approved", "product", first.requirement_desc, "", { package_id: first.package_id, version: first.version, payload: first });
    expect(listApprovedPackages()).toEqual([first]);
    const feedback = { event_id: "feedback-1", package_id: first.package_id, version: first.version, kind: "clarification" as const, note: "请补充尺码范围", design_version_id: null, image_url: null };
    saveDesignEvent(feedback);
    saveDesignEvent(feedback);
    expect(listDesignEvents()).toHaveLength(1);
    saveCase(signal.signal_id, "returned", "product", first.requirement_desc, feedback.note);
    const revised = buildApprovedPackage(signal, "改善通勤裤长，覆盖160–170cm", first.version);
    saveCase(signal.signal_id, "approved", "product", revised.requirement_desc, "", { package_id: revised.package_id, version: revised.version, payload: revised });
    expect(revised.version).toBe("v2");
    expect(listApprovedPackages()).toEqual([revised, first]);
  });
});
