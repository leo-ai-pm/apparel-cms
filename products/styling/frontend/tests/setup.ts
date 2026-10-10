import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { resetConsumerProfileInitialization } from "../app/lib/consumer-profile";

beforeEach(() => resetConsumerProfileInitialization());

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
Element.prototype.scrollIntoView = vi.fn();
// jsdom/vitest 的 URL.createObjectURL 对假 File 会报错，测试里直接用简单 mock（本地图片预览用）
URL.createObjectURL = vi.fn(() => "blob:mock");
URL.revokeObjectURL = vi.fn();
