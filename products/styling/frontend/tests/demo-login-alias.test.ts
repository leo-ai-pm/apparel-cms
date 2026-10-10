import { afterEach, expect, it, vi } from "vitest";
import Login from "../app/login/page";
import AdminLogin from "../app/admin/login/page";
import ConsumerLogin from "../app/platform/login/page";
const redirected = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_REDIRECT"); }));
vi.mock("next/navigation", () => ({ redirect: redirected }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each([[Login, "/admin"], [AdminLogin, "/admin"], [ConsumerLogin, "/"]] as const)("old bookmark maps to a fixed same-origin destination %#", (Page, target) => {
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", ""); expect(() => Page()).toThrow("NEXT_REDIRECT"); expect(redirected).toHaveBeenCalledWith(target);
});
