import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminPage from "../app/admin/page";
import { AdminError } from "../app/lib/admin-api";
import type { ApprovalSet, Evidence, GroupDetail, HandoffDetail, Overview, PageResult, Turn, TurnDetail } from "../app/lib/admin-api";

// Component-only fixtures: these mocks never establish real backend or partner acceptance.
const mocked = vi.hoisted(() => ({ api: vi.fn(), export: vi.fn() }));
vi.mock("../app/lib/admin-api", async importOriginal => ({
  ...await importOriginal<typeof import("../app/lib/admin-api")>(),
  adminApi: mocked.api,
  adminExport: mocked.export,
}));

const stamp = "2026-10-08T00:00:00.123456Z";
const start = "2026-10-01T00:00:00.123456Z";
const digest = "a".repeat(64);
const eligibility = (eligible = true): ApprovalSet["approval_eligibility"] => ({
  policy: "pause-inactive-sources-v1", eligible,
  reason_codes: eligible ? [] : ["source_inactive"],
  blocked_sources: eligible ? [] : [{ turn_id: "turn-context", occurrence_id: "occ-context", revision: 2,
    review_state: "rejected", lifecycle: "excluded" }],
  message: eligible ? "当前来源未触发暂停；仍须人工核对全部证据与出处。"
    : "引用来源含已排除或无效记录，相关新审批已暂停；重新核对不会解除，请等待人工复核。",
});
type ApprovalFixture = ApprovalSet;
type GroupFixture = GroupDetail;
type OverviewFixture = Overview;
const evidence = (changes: Partial<Evidence> = {}): Evidence => ({
  id: "occ-current", turn_id: "turn-current", group_key: "group-one", title: "通勤裤子",
  description: "合成需求", attributes: { category: "裤子", scene: "通勤", fit: "宽松", season: null, silhouette: null },
  review_state: "pending", reason: "", revision: 3, lifecycle: "active", normalizer_version: "rules-v2",
  context_turn_ids: ["turn-context"], field_sources: { category: ["turn-context"], scene: ["turn-context"], fit: ["turn-current"] },
  session_id: "fixture-session", text: "再宽松一点", created_at: stamp, extractor: "rules-v2", data_origin: "simulation_fixture",
  ...changes,
});
const groupDetail = (changes: Partial<GroupFixture> = {}): GroupFixture => ({
  window_start: start, window_end: stamp, evidence: [evidence()], handoffs: [],
  total: changes.evidence?.length ?? 1, page: 1, page_size: 40, has_more: false, pagination_mode: "paged", ...changes,
});
const approvalSet = (items: Evidence[] = [evidence()], changes: Partial<ApprovalFixture> = {}): ApprovalFixture => {
  const active = items.filter(item => item.lifecycle === "active" && item.review_state !== "rejected");
  return { group_key: "group-one", days: 7, window_start: start, window_end: stamp, active_count: active.length,
    expected_occurrence_ids: active.map(item => item.id), expected_revisions: Object.fromEntries(active.map(item => [item.id, item.revision])),
    evidence_digest: digest, approval_eligibility: eligibility(), ...changes };
};
const turn = (id = "turn-current", changes: Partial<Turn> = {}): Turn => ({
  id, session_id: "fixture-session", text: "再宽松一点", status: "extracted", extractor: "rules-v2",
  data_origin: "simulation_fixture", created_at: stamp, error_code: "", extraction_attempts: 1,
  negative_preferences: [], occurrences: [evidence()], ...changes,
});
const turnDetail = (): TurnDetail => ({
  ...turn(), context_turns: [turn("turn-context", { text: "通勤想要裤子", occurrences: [] })], revision_history: [],
});
const contextTurnDetail = (changes: Partial<TurnDetail> = {}): TurnDetail => ({
  ...turn("turn-context", { text: "通勤想要裤子", occurrences: [evidence({ id: "occ-context", turn_id: "turn-context",
    text: "通勤想要裤子", revision: 1, attributes: { category: "裤子", scene: "通勤", fit: null },
    context_turn_ids: [], field_sources: { category: ["turn-context"], scene: ["turn-context"] } })] }),
  context_turns: [], revision_history: [], ...changes,
});
const handoffDetail = (changes: Partial<HandoffDetail> = {}): HandoffDetail => ({
  id: "DH-fixture", group_key: "group-one", title: "通勤裤子", version: 2, status: "approved", created_at: stamp, last_error: "", occurrences: 1,
  needs_review: false, review_reasons: [], send_eligible: true, send_in_progress: false, retry_after_seconds: 0,
  received_at: null, metadata: { approved_by: "styling-manager", window_start: start, window_end: stamp, evidence_revisions: { "occ-current": 3 } },
  payload: {
    schema_version: "1.4", handoff_id: "DH-fixture", revision: 2, source_agent: "styling", target_agent: "product",
    data_origin: "simulation_fixture", approved_at: stamp, review_note: "已核对",
    demand: { group_key: "group-one", title: "通勤裤子", description: "合成需求", attributes: { category: "裤子" },
      occurrences: 1, session_count: 1, window_days: 7, material: null, craft: null, knowledge_status: "pending_database" },
    evidence: [{ occurrence_id: "occ-current", turn_id: "turn-current", session_ref: "fixture-session", text: "再宽松一点",
      created_at: stamp, extractor: "rules-v2", data_origin: "simulation_fixture" }],
  },
  send_attempts: [], audit: [], ...changes,
});
const overview = (changes: Partial<OverviewFixture> = {}): OverviewFixture => ({
  scope: "fixture-scope", days: 7, window_start: start, window_end: stamp, updated_at: stamp, receiver_configured: true,
  groups: [{ key: "group-one", title: "通勤裤子", description: "合成需求", attributes: { category: "裤子" }, count: 1,
    session_count: 1, pending: 1, last_seen: stamp, data_origins: ["simulation_fixture"], handoff: null }],
  groups_total: 1, page: 1, page_size: 20, has_more: false,
  turns: [], images: [], counts: { turns: 11, occurrences: 1, groups: 1, pending: 1, pending_handoffs: 0,
    tasks: 0, succeeded: 0, failed: 0, processing: 0 },
  storage: { database: "fixture.sqlite", results: "fixture-results", uploads: "fixture-uploads", raw_photo_policy: "不持久保存" },
  ...changes,
});
const paged = <T,>(items: T[], page = 1, total = items.length): PageResult<T> => ({ items, page, total, page_size: 10 });
const query = (path: string) => new URLSearchParams(path.split("?")[1]);
const evidencePage = (items: Evidence[], path: string, changes: Partial<GroupFixture> = {}): GroupFixture => {
  const params = query(path), page = Number(params.get("page") || 1), size = Number(params.get("page_size") || 40);
  return groupDetail({ evidence: items.slice((page - 1) * size, page * size), total: items.length,
    page, page_size: size, has_more: page * size < items.length, ...changes });
};
const manyEvidence = (count: number) => Array.from({ length: count }, (_, index) => {
  const suffix = String(index + 1).padStart(3, "0"), id = `turn-${suffix}`;
  return evidence({ id: `occ-${suffix}`, turn_id: id, text: `合成原话${suffix}`, context_turn_ids: [],
    field_sources: { category: [id], scene: [id], fit: [id] } });
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
type RouteHandler = (path: string, body?: unknown) => unknown | Promise<unknown>;
function routes(override?: RouteHandler) {
  mocked.api.mockImplementation(async (path: string, body?: unknown) => {
    const custom = override?.(path, body);
    if (custom !== undefined) return custom;
    if (path.startsWith("overview?")) return overview();
    if (path.startsWith("groups/group-one/approval-set?")) return approvalSet();
    if (path.startsWith("groups/group-one?")) return groupDetail();
    if (path === "turns/turn-current") return turnDetail();
    if (path === "turns/turn-context") return contextTurnDetail();
    if (path.startsWith("turns?")) return paged([turn()]);
    if (path.startsWith("handoffs?")) return paged([handoffDetail()]);
    if (path === "handoffs/DH-fixture") return handoffDetail();
    if (path === "login" || path === "logout") return {};
    throw new Error(`Unexpected mocked component route: ${path}`);
  });
}
async function ready() {
  render(<AdminPage />);
  await screen.findByRole("heading", { name: "需求热度榜单" });
}
async function openGroup(user = userEvent.setup()) {
  await user.click(screen.getByRole("button", { name: /查看与审核/ }));
  return within(await screen.findByRole("dialog"));
}
async function checkVisible(dialog: ReturnType<typeof within>, user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(dialog.getByRole("button", { name: "刷新核对数据" })).toBeEnabled());
  for (const checkbox of await dialog.findAllByRole("checkbox", { name: /已核对原话与出处/ })) {
    if (checkbox.hasAttribute("disabled")) {
      await user.click(within(checkbox.closest("article")!).getByRole("button", { name: /查看原话与跨轮出处/ }));
      await dialog.findByRole("heading", { name: "每个字段的用户出处" });
      await user.click(dialog.getByRole("button", { name: "返回需求核对" }));
      await waitFor(() => expect(checkbox).toBeEnabled());
    }
    if (!(checkbox as HTMLInputElement).checked) await user.click(checkbox);
  }
}
async function openHandoff(user = userEvent.setup()) {
  await user.click(within(screen.getByRole("navigation", { name: "后台栏目" })).getByRole("button", { name: "审批与交接" }));
  await user.click(await screen.findByRole("button", { name: /查看冻结快照与交接记录/ }));
  const dialog = within(await screen.findByRole("dialog"));
  await dialog.findByRole("button", { name: "导出冻结交接包" });
  return dialog;
}

const dialogShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
beforeEach(() => {
  mocked.api.mockReset(); mocked.export.mockReset();
  sessionStorage.clear();
  // jsdom does not implement the native dialog's browser modality.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true, value: function (this: HTMLDialogElement) { this.open = true; },
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (dialogShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", dialogShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
});

describe("S1管理页组件行为（集中API mock，非真实联调）", () => {
  it("401进入登录，登录后加载管理数据，退出清除管理内容", async () => {
    let loggedIn = false;
    const sessionKey = "styling.admin-direct-session.v1:/";
    sessionStorage.setItem(sessionKey, "previous-admin-session");
    sessionStorage.setItem("styling.admin-direct-pending.v1:previous-admin-session", "original-action-only");
    routes((path, body) => {
      if (path.startsWith("overview?") && !loggedIn) throw new AdminError(401, "UNAUTHORIZED", "登录已失效");
      if (path === "login") { expect(body).toEqual({ password: "fixture-password-only" }); loggedIn = true; return {}; }
      if (path === "logout") { loggedIn = false; return {}; }
    });
    const user = userEvent.setup();
    render(<AdminPage />);
    await user.type(await screen.findByLabelText("管理员密码"), "fixture-password-only");
    await user.click(screen.getByRole("button", { name: "进入管理后台" }));
    await screen.findByRole("heading", { name: "需求热度榜单" });
    expect(sessionStorage.getItem(sessionKey)).toBeTruthy();
    expect(sessionStorage.getItem(sessionKey)).not.toBe("previous-admin-session");
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    expect(await screen.findByLabelText("管理员密码")).toHaveValue("");
    expect(screen.queryByText("通勤裤子")).not.toBeInTheDocument();
    expect(mocked.api).toHaveBeenCalledWith("logout", {});
    expect(sessionStorage.getItem(sessionKey)).toBeNull();
    expect(sessionStorage.getItem("styling.admin-direct-pending.v1:previous-admin-session")).toBe("original-action-only");
  });

  it("详情401移除已加载证据及管理导航，避免显示过期授权资料", async () => {
    routes(path => { if (path.startsWith("groups/")) throw new AdminError(401, "UNAUTHORIZED", "过期"); });
    await ready(); await userEvent.setup().click(screen.getByRole("button", { name: /查看与审核/ }));
    expect(await screen.findByLabelText("管理员密码")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "后台栏目" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem("styling.admin-direct-session.v1:/")).toBeNull();
  });

  it("概览加载期间不把未知统计显示为0；空范围明确提示无需求", async () => {
    const pending = deferred<Overview>();
    routes(path => path.startsWith("overview?") ? pending.promise : undefined);
    render(<AdminPage />);
    expect(screen.getByRole("status")).toHaveTextContent("正在验证管理权限");
    expect(screen.queryByRole("heading", { name: "需求热度榜单" })).not.toBeInTheDocument();
    await act(async () => { pending.resolve(overview({ groups: [], groups_total: 0, counts: { ...overview().counts, groups: 0, occurrences: 0, pending: 0 } })); });
    expect(await screen.findByText("当前范围没有有效需求")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查看与审核/ })).not.toBeInTheDocument();
  });

  it("概览刷新失败保留上次结果并禁用审核入口，重新查询成功后恢复", async () => {
    let fail = false;
    routes(path => { if (path.startsWith("overview?") && fail) throw new AdminError(500, "INTERNAL", "服务暂时失败"); });
    const user = userEvent.setup(); await ready(); fail = true;
    await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("当前为上次结果");
    expect(screen.getByText("通勤裤子")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /查看与审核/ })).toBeDisabled();
    fail = false; await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /查看与审核/ })).toBeEnabled();
  });

  it("热度刷新后组数减少时返回有效分页，仍能看到剩余需求", async () => {
    let reduced = false;
    const groups = Array.from({ length: 21 }, (_, index) => ({
      ...overview().groups[0], key: `group-${index + 1}`, title: `需求${index + 1}`,
    }));
    routes(path => {
      if (!path.startsWith("overview?")) return;
      const all = reduced ? groups.slice(0, 1) : groups, page = Number(query(path).get("page") || 1);
      return overview({ groups: all.slice((page - 1) * 20, page * 20), groups_total: all.length,
        page, has_more: page * 20 < all.length, counts: { ...overview().counts, groups: all.length } });
    });
    const user = userEvent.setup(); await ready();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("需求21")).toBeInTheDocument();
    expect(screen.getByText("共 21 条 · 第 2 / 2 页")).toBeInTheDocument();
    reduced = true; await user.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByText("需求1")).toBeInTheDocument();
    expect(screen.getByText("共 1 条 · 第 1 / 1 页")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /查看与审核/ })).toBeEnabled();
  });

  it("交流下一页使用服务端分页；错误保留会话输入并允许重试原页", async () => {
    let failSecond = true;
    routes(path => {
      if (!path.startsWith("turns?")) return;
      const params = new URLSearchParams(path.split("?")[1]);
      if (params.get("page") === "2") {
        if (failSecond) throw new AdminError(500, "INTERNAL", "暂时失败");
        return paged([turn("turn-page-two", { text: "第二页合成原话" })], 2, 11);
      }
      return paged([turn()], 1, 11);
    });
    const user = userEvent.setup(); await ready();
    await user.click(within(screen.getByRole("navigation", { name: "后台栏目" })).getByRole("button", { name: "交流记录" }));
    await screen.findByText("再宽松一点");
    await user.type(screen.getByLabelText("会话编号"), "保留未提交的输入");
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时失败");
    expect(screen.getByLabelText("会话编号")).toHaveValue("保留未提交的输入");
    failSecond = false;
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("第二页合成原话")).toBeInTheDocument();
    expect(mocked.api.mock.calls.filter(([path]) => String(path).startsWith("turns?")).at(-1)?.[0]).toContain("page=2&page_size=10");
    expect(screen.getByText("共 11 条 · 第 2 / 2 页")).toBeInTheDocument();
  });

  it("字段出处展示此前用户交流与当前原话，未知季节不补猜", async () => {
    routes(); const user = userEvent.setup(); await ready();
    const group = await openGroup(user);
    await checkVisible(group, user);
    await user.click(await group.findByRole("button", { name: /查看原话与跨轮出处/ }));
    const detail = within(screen.getByRole("dialog"));
    await detail.findByRole("heading", { name: "每个字段的用户出处" });
    expect(detail.getAllByText("通勤想要裤子")).toHaveLength(2);
    expect(detail.getAllByText("此前用户交流 · turn-context")).toHaveLength(2);
    expect(detail.getByText("当前交流 · turn-current")).toBeInTheDocument();
    expect(detail.getAllByText("未明确").length).toBeGreaterThanOrEqual(2);
    expect(detail.queryByRole("button", { name: /恢复|撤回/ })).not.toBeInTheDocument();
    await user.click(detail.getByRole("button", { name: "返回需求核对" }));
    expect(detail.getByRole("checkbox", { name: "已核对原话与出处：occ-current" })).toBeChecked();
    expect(detail.getByText("已核对 1 / 1 条有效证据")).toBeInTheDocument();
  });

  it("详情内切换来源后关闭，将焦点还给最初打开详情的列表按钮", async () => {
    routes(); const user = userEvent.setup(); await ready();
    const opener = screen.getByRole("button", { name: /查看与审核/ });
    const group = await openGroup(user);
    await user.click(await group.findByRole("button", { name: /查看原话与跨轮出处/ }));
    const detail = within(screen.getByRole("dialog"));
    await detail.findByRole("heading", { name: "每个字段的用户出处" });
    await user.click(detail.getByRole("button", { name: "关闭详情" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("来源刷新未完成就返回核对时，迟到错误不污染核对页且保留说明、勾选、焦点和滚动", async () => {
    const pending = deferred<TurnDetail>();
    let delayRefresh = false;
    routes(path => path === "turns/turn-current" && delayRefresh ? pending.promise : undefined);
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "核对说明需要完整保留");
    await checkVisible(dialog, user);
    const sourceButton = dialog.getByRole("button", { name: /查看原话与跨轮出处/ });
    const drawer = sourceButton.closest("section")!;
    drawer.scrollTop = 416;
    await user.click(sourceButton);
    await dialog.findByRole("heading", { name: "每个字段的用户出处" });
    delayRefresh = true;
    await user.click(dialog.getByRole("button", { name: "重新查询当前记录" }));
    expect(dialog.getByText("正在加载详情…")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "返回需求核对" }));
    await act(async () => { pending.reject(new AdminError(500, "INTERNAL", "迟到的来源错误")); });
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
    expect(dialog.queryByText("迟到的来源错误")).not.toBeInTheDocument();
    expect(dialog.queryByText("正在加载详情…")).not.toBeInTheDocument();
    expect(dialog.getByRole("textbox")).toHaveValue("核对说明需要完整保留");
    expect(dialog.getByRole("checkbox", { name: "已核对原话与出处：occ-current" })).toBeChecked();
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeEnabled();
    expect(sourceButton).toHaveFocus();
    expect(drawer.scrollTop).toBe(416);
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/approve"))).toBe(false);
  });

  it("批准传完整所见修订与原UTC窗口，提交期间不重复请求", async () => {
    const pending = deferred<object>();
    routes(path => path === "groups/group-one/approve" ? pending.promise : undefined);
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "核对全部用户出处");
    await checkVisible(dialog, user);
    await user.dblClick(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    const writes = mocked.api.mock.calls.filter(([path]) => path === "groups/group-one/approve");
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toEqual({ note: "核对全部用户出处", days: 7,
      expected_occurrence_ids: ["occ-current"], expected_revisions: { "occ-current": 3 }, expected_evidence_digest: digest, window_start: start, window_end: stamp });
    expect(dialog.getByRole("button", { name: "正在核验并提交…" })).toBeDisabled();
    await act(async () => { pending.resolve({}); });
    expect(await dialog.findByText(/当前证据快照已批准并保存/)).toBeInTheDocument();
  });

  it("缺字段用户出处的有效证据禁止批准", async () => {
    routes(path => path.startsWith("groups/group-one?") ? groupDetail({ evidence: [evidence({ field_sources: {} })] }) : undefined);
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "说明已填写");
    expect(dialog.getByText(/来源缺失.*当前不能/)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/approve"))).toBe(false);
  });

  it("详情重新查询失败时保留原话及说明，禁止排除旧证据，查新记录成功后恢复", async () => {
    let fail = false;
    routes(path => { if (path.startsWith("groups/group-one?") && fail) throw new AdminError(500, "INTERNAL", "证据查询暂时失败"); });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "保留排除理由");
    expect(dialog.getByRole("button", { name: "排除这条记录" })).toBeEnabled();
    fail = true; await user.click(dialog.getByRole("button", { name: "刷新核对数据" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("证据查询暂时失败");
    expect(dialog.getByText("再宽松一点")).toBeInTheDocument();
    expect(dialog.getByRole("textbox")).toHaveValue("保留排除理由");
    expect(dialog.getByRole("button", { name: "排除这条记录" })).toBeDisabled();
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/reject"))).toBe(false);
    fail = false; await user.click(dialog.getByRole("button", { name: "刷新核对数据" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "排除这条记录" })).toBeEnabled());
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("排除必须带理由及所见修订，409后重载新修订并保留说明，不自动再次写入", async () => {
    let changed = false;
    routes((path, body) => {
      if (path === "occurrences/occ-current/reject") {
        expect(body).toEqual({ note: "误提炼需要排除", expected_revision: 3 });
        changed = true; throw new AdminError(409, "CONFLICT", "证据修订已变化");
      }
      if (path.startsWith("groups/group-one?")) return groupDetail({ evidence: [evidence({ revision: changed ? 4 : 3 })] });
    });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    expect(await dialog.findByRole("button", { name: "排除这条记录" })).toBeDisabled();
    await user.type(dialog.getByRole("textbox"), "误提炼需要排除");
    await user.click(dialog.getByRole("button", { name: "排除这条记录" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("已重新查询，说明已保留");
    expect(dialog.getByRole("textbox")).toHaveValue("误提炼需要排除");
    expect(dialog.getByText(/修订 4/)).toBeInTheDocument();
    expect(mocked.api.mock.calls.filter(([path]) => path === "occurrences/occ-current/reject")).toHaveLength(1);
  });

  it("批准409重载证据、保留审核说明且不自动批准更新版本", async () => {
    routes(path => { if (path === "groups/group-one/approve") throw new AdminError(409, "CONFLICT", "证据集合已变化"); });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "保留审核说明");
    await checkVisible(dialog, user);
    await user.click(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("证据集合已变化");
    expect(dialog.getByRole("textbox")).toHaveValue("保留审核说明");
    expect(dialog.queryByRole("checkbox", { name: /已核对原话与出处/, checked: true })).not.toBeInTheDocument();
    expect(mocked.api.mock.calls.filter(([path]) => String(path).startsWith("groups/group-one?")).length).toBe(2);
    expect(mocked.api.mock.calls.filter(([path]) => path === "groups/group-one/approve")).toHaveLength(1);
    expect(dialog.queryByText(/快照已批准并保存/)).not.toBeInTheDocument();
  });

  it("409后的刷新和查询重试不建立新A；必须明确重新开始、逐条核对后再提交所见A", async () => {
    let submitted = 0, newerBaseline = false, failPage = false;
    const nextDigest = "b".repeat(64);
    routes((path, body) => {
      if (path.startsWith("groups/group-one/approval-set?")) return approvalSet(undefined, { evidence_digest: newerBaseline ? nextDigest : digest });
      if (path.startsWith("groups/group-one?")) {
        if (failPage) throw new AdminError(500, "INTERNAL", "来源分页暂时不可读");
        return groupDetail();
      }
      if (path === "groups/group-one/approve") {
        submitted++;
        if (submitted === 1) {
          expect((body as { expected_evidence_digest: string }).expected_evidence_digest).toBe(digest);
          newerBaseline = true; throw new AdminError(409, "CONFLICT", "审批基准已变化");
        }
        return {};
      }
    });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "冲突后保留并重新逐条核对的说明");
    await checkVisible(dialog, user);
    await user.click(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("审批基准已变化");
    expect(dialog.getByRole("textbox")).toHaveValue("冲突后保留并重新逐条核对的说明");
    const checkbox = () => dialog.getByRole("checkbox", { name: "已核对原话与出处：occ-current" });
    expect(checkbox()).not.toBeChecked(); expect(checkbox()).toBeDisabled();
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    failPage = true;
    await user.click(dialog.getByRole("button", { name: "刷新核对数据" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("来源分页暂时不可读");
    failPage = false;
    await user.click(dialog.getByRole("button", { name: "重试来源查询" }));
    await waitFor(() => expect(dialog.queryByRole("alert")).not.toBeInTheDocument());
    expect(checkbox()).not.toBeChecked(); expect(checkbox()).toBeDisabled();
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    expect(submitted).toBe(1);
    await user.click(dialog.getByRole("button", { name: "重新开始全部核对" }));
    expect(await dialog.findByText("已核对 0 / 1 条有效证据")).toBeInTheDocument();
    expect(dialog.getByRole("textbox")).toHaveValue("冲突后保留并重新逐条核对的说明");
    expect(checkbox()).not.toBeChecked();
    await checkVisible(dialog, user);
    await user.click(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    expect(await dialog.findByText(/当前证据快照已批准并保存/)).toBeInTheDocument();
    const writes = mocked.api.mock.calls.filter(([path]) => path === "groups/group-one/approve");
    expect(writes).toHaveLength(2);
    expect(writes[1][1]).toEqual({ note: "冲突后保留并重新逐条核对的说明", days: 7,
      expected_occurrence_ids: ["occ-current"], expected_revisions: { "occ-current": 3 },
      expected_evidence_digest: nextDigest, window_start: start, window_end: stamp });
  });

  it("来源资格暂停在打开时关闭批准，分页、刷新、重新开始和重读出处均不能解除且说明保留", async () => {
    const items = [evidence(), ...manyEvidence(40)];
    routes(path => {
      if (path.startsWith("groups/group-one/approval-set?")) return approvalSet(items, { approval_eligibility: eligibility(false) });
      if (path.startsWith("groups/group-one?")) return evidencePage(items, path);
      if (path === "turns/turn-context") return contextTurnDetail({ occurrences: contextTurnDetail().occurrences.map(item => ({
        ...item, revision: 2, review_state: "rejected", lifecycle: "excluded", reason: "已排除的相关出处",
      })) });
    });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    const approve = () => dialog.getByRole("button", { name: "核验并批准当前证据快照" });
    const paused = async () => {
      await waitFor(() => expect(dialog.getByRole("button", { name: "刷新核对数据" })).toBeEnabled());
      expect(screen.getByRole("dialog")).toHaveTextContent(/审批已暂停.*等待人工复核/);
      expect(screen.getByRole("dialog")).toHaveTextContent("turn-context");
      expect(screen.getByRole("dialog")).toHaveTextContent("occ-context");
      expect(approve()).toBeDisabled();
      expect(dialog.queryByText(/当前证据快照已批准并保存/)).not.toBeInTheDocument();
    };
    await paused();
    await user.type(dialog.getByRole("textbox"), "暂停状态下保留人工复核说明");
    const pager = within(dialog.getByRole("navigation", { name: "来源证据分页" }));
    await user.click(pager.getByRole("button", { name: "下一页" }));
    expect(await dialog.findByText("共 41 条 · 第 2 / 2 页")).toBeInTheDocument();
    await paused();
    await user.click(pager.getByRole("button", { name: "上一页" }));
    expect(await dialog.findByText("共 41 条 · 第 1 / 2 页")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "刷新核对数据" }));
    await paused();
    await user.click(dialog.getByRole("button", { name: "重新开始全部核对" }));
    await paused();
    const sourceArticle = dialog.getByRole("checkbox", { name: "已核对原话与出处：occ-current" }).closest("article")!;
    await user.click(within(sourceArticle).getByRole("button", { name: /查看原话与跨轮出处/ }));
    await dialog.findByRole("heading", { name: "每个字段的用户出处" });
    expect(mocked.api.mock.calls.some(([path]) => path === "turns/turn-context")).toBe(true);
    await user.click(dialog.getByRole("button", { name: "返回需求核对" }));
    await paused();
    expect(dialog.getByRole("textbox")).toHaveValue("暂停状态下保留人工复核说明");
    await user.click(approve());
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/approve"))).toBe(false);
  });

  it("SOURCE_APPROVAL_BLOCKED保留说明并清核对，提示人工复核而不建议重启核对来恢复批准", async () => {
    let blocked = false;
    routes(path => {
      if (path.startsWith("groups/group-one/approval-set?")) return approvalSet(undefined, { approval_eligibility: eligibility(!blocked) });
      if (path === "groups/group-one/approve") {
        blocked = true;
        throw new AdminError(409, "SOURCE_APPROVAL_BLOCKED", eligibility(false).message, eligibility(false));
      }
    });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "提交时暂停仍要保留的说明");
    await checkVisible(dialog, user);
    await user.click(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "刷新核对数据" })).toBeEnabled());
    expect(screen.getByRole("dialog")).toHaveTextContent(/审批已暂停.*等待人工复核/);
    expect(dialog.getByRole("textbox")).toHaveValue("提交时暂停仍要保留的说明");
    expect(dialog.queryByRole("checkbox", { name: /已核对原话与出处/, checked: true })).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    expect(dialog.queryAllByText(/请(?:点|重新).*重新开始全部核对/)).toHaveLength(0);
    expect(dialog.queryByText(/快照已批准并保存/)).not.toBeInTheDocument();
    expect(mocked.api.mock.calls.filter(([path]) => path === "groups/group-one/approve")).toHaveLength(1);
  });

  it("普通CONFLICT后重新查询发现来源暂停，显式重新开始也不恢复批准且保留说明", async () => {
    let blocked = false;
    routes(path => {
      if (path.startsWith("groups/group-one/approval-set?")) return approvalSet(undefined, { approval_eligibility: eligibility(!blocked) });
      if (path === "groups/group-one/approve") {
        blocked = true; throw new AdminError(409, "CONFLICT", "提交时证据摘要已变化");
      }
    });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "摘要冲突后暂停的说明");
    await checkVisible(dialog, user);
    await user.click(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "刷新核对数据" })).toBeEnabled());
    expect(screen.getByRole("dialog")).toHaveTextContent(/审批已暂停.*等待人工复核/);
    expect(dialog.queryByRole("checkbox", { name: /已核对原话与出处/, checked: true })).not.toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "重新开始全部核对" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "刷新核对数据" })).toBeEnabled());
    expect(dialog.getByRole("textbox")).toHaveValue("摘要冲突后暂停的说明");
    expect(screen.getByRole("dialog")).toHaveTextContent(/审批已暂停.*等待人工复核/);
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    expect(mocked.api.mock.calls.filter(([path]) => path === "groups/group-one/approve")).toHaveLength(1);
  });

  it.each([
    ["缺资格", undefined],
    ["未知政策", { ...eligibility(), policy: "unconfirmed-future-policy" }],
    ["异常结构", { ...eligibility(), eligible: "true" }],
  ])("%s的预览不能默认允许批准，明确资格错误并保留输入", async (_, invalidEligibility) => {
    routes(path => path.startsWith("groups/group-one/approval-set?") ? approvalSet(undefined, {
      approval_eligibility: invalidEligibility as unknown as ApprovalSet["approval_eligibility"],
    }) : undefined);
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await waitFor(() => expect(dialog.getByRole("button", { name: "刷新核对数据" })).toBeEnabled());
    expect(dialog.getAllByRole("alert").map(node => node.textContent).join(" ")).toMatch(/资格|政策/);
    await user.type(dialog.getByRole("textbox"), "异常资格不能默认通过");
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    await user.click(dialog.getByRole("button", { name: "刷新核对数据" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "刷新核对数据" })).toBeEnabled());
    expect(dialog.getByRole("textbox")).toHaveValue("异常资格不能默认通过");
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/approve"))).toBe(false);
  });

  it("A/B的ID修订摘要相同但来源资格变化，清核对保留说明且不POST批准", async () => {
    let blocked = false;
    routes(path => path.startsWith("groups/group-one/approval-set?") ? approvalSet(undefined, {
      approval_eligibility: eligibility(!blocked),
    }) : undefined);
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "只改变来源资格也不能继续批准");
    await checkVisible(dialog, user);
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeEnabled();
    blocked = true;
    await user.click(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "刷新核对数据" })).toBeEnabled());
    expect(screen.getByRole("dialog")).toHaveTextContent(/审批已暂停.*等待人工复核/);
    expect(dialog.getByRole("textbox")).toHaveValue("只改变来源资格也不能继续批准");
    expect(dialog.queryByRole("checkbox", { name: /已核对原话与出处/, checked: true })).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/approve"))).toBe(false);
  });

  it("明确重新开始清除上一轮跨轮出处已读缓存，保留说明但必须重新查询出处才能勾选", async () => {
    routes(); const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "重新开始仍需保留的核对说明");
    await checkVisible(dialog, user);
    const checkbox = () => dialog.getByRole("checkbox", { name: "已核对原话与出处：occ-current" });
    expect(checkbox()).toBeChecked(); expect(checkbox()).toBeEnabled();
    const reads = (id: string) => mocked.api.mock.calls.filter(([path]) => path === `turns/${id}`).length;
    const currentReads = reads("turn-current"), contextReads = reads("turn-context");
    expect(currentReads).toBeGreaterThan(0); expect(contextReads).toBeGreaterThan(0);
    await user.click(dialog.getByRole("button", { name: "重新开始全部核对" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "刷新核对数据" })).toBeEnabled());
    expect(dialog.getByText("已核对 0 / 1 条有效证据")).toBeInTheDocument();
    expect(dialog.getByRole("textbox")).toHaveValue("重新开始仍需保留的核对说明");
    expect(checkbox()).not.toBeChecked(); expect(checkbox()).toBeDisabled();
    expect(reads("turn-current")).toBe(currentReads); expect(reads("turn-context")).toBe(contextReads);
    await user.click(dialog.getByRole("button", { name: /查看原话与跨轮出处/ }));
    await dialog.findByRole("heading", { name: "每个字段的用户出处" });
    expect(reads("turn-current")).toBe(currentReads + 1); expect(reads("turn-context")).toBe(contextReads + 1);
    await user.click(dialog.getByRole("button", { name: "返回需求核对" }));
    expect(checkbox()).toBeEnabled(); expect(checkbox()).not.toBeChecked();
    await user.click(checkbox());
    expect(dialog.getByText("已核对 1 / 1 条有效证据")).toBeInTheDocument();
    expect(dialog.getByRole("textbox")).toHaveValue("重新开始仍需保留的核对说明");
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/approve"))).toBe(false);
  });

  it("普通刷新保留固定截止和核对状态；明确更新范围后重新打开从零核对新截止", async () => {
    const nextStart = "2026-10-02T00:00:00.654321Z", nextEnd = "2026-10-09T00:00:00.654321Z";
    let serverNowMoved = false;
    routes(path => {
      if (path.startsWith("overview?")) {
        const pinnedEnd = query(path).get("window_end");
        const useNew = serverNowMoved && !pinnedEnd;
        return overview({ window_start: useNew ? nextStart : start, window_end: useNew ? nextEnd : pinnedEnd || stamp });
      }
      if (path.startsWith("groups/group-one/approval-set?")) return approvalSet(undefined, {
        window_start: query(path).get("window_start"), window_end: query(path).get("window_end")!,
      });
      if (path.startsWith("groups/group-one?")) return groupDetail({
        window_start: query(path).get("window_start"), window_end: query(path).get("window_end")!,
      });
    });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "当前固定窗口的核对说明");
    await checkVisible(dialog, user);
    serverNowMoved = true;
    await user.click(dialog.getByRole("button", { name: "刷新核对数据" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "刷新核对数据" })).toBeEnabled());
    expect(dialog.getByRole("checkbox", { name: "已核对原话与出处：occ-current" })).toBeChecked();
    expect(dialog.getByRole("textbox")).toHaveValue("当前固定窗口的核对说明");
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeEnabled();
    const sourceReads = mocked.api.mock.calls.filter(([path]) => String(path).startsWith("groups/group-one?"));
    expect(query(sourceReads.at(-1)![0]).get("window_end")).toBe(stamp);
    await user.click(dialog.getByRole("button", { name: "关闭详情" }));
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled());
    let overviewReads = mocked.api.mock.calls.filter(([path]) => String(path).startsWith("overview?"));
    expect(query(overviewReads.at(-1)![0]).get("window_end")).toBe(stamp);
    await user.click(screen.getByRole("button", { name: "更新查询范围" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /查看与审核/ })).toBeEnabled());
    overviewReads = mocked.api.mock.calls.filter(([path]) => String(path).startsWith("overview?"));
    expect(query(overviewReads.at(-1)![0]).has("window_end")).toBe(false);
    const fresh = await openGroup(user);
    expect(await fresh.findByText("已核对 0 / 1 条有效证据")).toBeInTheDocument();
    expect(fresh.getByRole("checkbox", { name: "已核对原话与出处：occ-current" })).not.toBeChecked();
    expect(fresh.getByRole("textbox")).toHaveValue("");
    expect(fresh.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    const freshReads = mocked.api.mock.calls.filter(([path]) => String(path).startsWith("groups/group-one?") || String(path).startsWith("groups/group-one/approval-set?"));
    expect(query(freshReads.at(-1)![0]).get("window_start")).toBe(nextStart);
    expect(query(freshReads.at(-1)![0]).get("window_end")).toBe(nextEnd);
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/approve"))).toBe(false);
  });

  it("导出下载冻结文件后仍为未发送，不制造接收事实", async () => {
    mocked.export.mockResolvedValue({ blob: new Blob(["{}"], { type: "application/json" }), fileName: "DH-fixture.json" });
    routes(); const user = userEvent.setup(); await ready(); const dialog = await openHandoff(user);
    await user.click(dialog.getByRole("button", { name: "导出冻结交接包" }));
    expect(await dialog.findByText("交接包已下载；导出不代表发送或接收。")).toBeInTheDocument();
    expect(dialog.getByText("尚未发送。导出不会创建发送尝试。")).toBeInTheDocument();
    expect(dialog.queryByText("已接收")).not.toBeInTheDocument();
    expect(mocked.export).toHaveBeenCalledWith("DH-fixture");
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/send"))).toBe(false);
  });

  it("查看变化后的当前出处再返回，冻结原话及修订保持批准当时事实且不改已提交A", async () => {
    const source = contextTurnDetail();
    const frozen = handoffDetail({ metadata: { ...handoffDetail().metadata,
      evidence_digest: digest, evidence_digest_version: "resolved-sources-v1",
      source_snapshot: [{ turn: source, occurrences: source.occurrences }] } });
    const frozenBefore = JSON.stringify(frozen.metadata.source_snapshot);
    let approved = false, showCurrent = false;
    routes(path => {
      if (path === "groups/group-one/approve") { approved = true; return {}; }
      if (path.startsWith("groups/group-one?")) return groupDetail({ handoffs: approved ? [frozen] : [] });
      if (path === "handoffs/DH-fixture") return frozen;
      if (path === "turns/turn-context" && showCurrent) return contextTurnDetail({ text: "当前已修改的出处原话",
        occurrences: source.occurrences.map(item => ({ ...item, revision: 2, review_state: "rejected", lifecycle: "excluded", reason: "来源后续被排除" })) });
    });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "按当时原话完成核对");
    await checkVisible(dialog, user);
    await user.click(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    await dialog.findByText(/当前证据快照已批准并保存/);
    const originalBody = { note: "按当时原话完成核对", days: 7, expected_occurrence_ids: ["occ-current"],
      expected_revisions: { "occ-current": 3 }, expected_evidence_digest: digest, window_start: start, window_end: stamp };
    expect(mocked.api.mock.calls.find(([path]) => path === "groups/group-one/approve")?.[1]).toEqual(originalBody);
    await user.click(dialog.getByRole("button", { name: /查看冻结快照与交接记录/ }));
    const frozenRegion = () => within(dialog.getByRole("region", { name: "批准当时的出处" }));
    expect(await frozenRegion().findByText("通勤想要裤子")).toBeInTheDocument();
    expect(within(frozenRegion().getByText("当时修订").parentElement!).getByText("1")).toBeInTheDocument();
    showCurrent = true;
    await user.click(frozenRegion().getByRole("button", { name: "查看当前出处" }));
    expect((await dialog.findAllByText("当前已修改的出处原话")).length).toBeGreaterThan(0);
    expect(dialog.getByText("已排除 · 已排除 · 修订 2")).toBeInTheDocument();
    expect(dialog.queryByRole("region", { name: "批准当时的出处" })).not.toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "返回批准时出处" }));
    expect(frozenRegion().getByText("通勤想要裤子")).toBeInTheDocument();
    expect(within(frozenRegion().getByText("当时修订").parentElement!).getByText("1")).toBeInTheDocument();
    expect(frozenRegion().queryByText("当前已修改的出处原话")).not.toBeInTheDocument();
    expect(frozenRegion().getByRole("button", { name: "查看当前出处" })).toHaveFocus();
    expect(JSON.stringify(frozen.metadata.source_snapshot)).toBe(frozenBefore);
    const writes = mocked.api.mock.calls.filter(([path]) => path === "groups/group-one/approve");
    expect(writes).toHaveLength(1); expect(writes[0][1]).toEqual(originalBody);
    expect(mocked.api.mock.calls.filter(([path]) => path === "handoffs/DH-fixture")).toHaveLength(1);
  });

  it("502发送失败后查询原快照并显示失败尝试，不自动重发或显示成功", async () => {
    let failed = false;
    routes(path => {
      if (path === "handoffs/DH-fixture/send") { failed = true; throw new AdminError(502, "RECEIVER_UNCONFIRMED", "接收未确认"); }
      if (path === "handoffs/DH-fixture" && failed) return handoffDetail({ status: "failed", send_attempts: [{
        id: "attempt-fixture", handoff_id: "DH-fixture", status: "failed", attempted_at: stamp, finished_at: stamp,
        error_code: "receipt_mismatch", receipt: {},
      }] });
    });
    const user = userEvent.setup(); await ready(); const dialog = await openHandoff(user);
    await user.click(dialog.getByRole("button", { name: "上传产品部门" }));
    await user.click(dialog.getByRole("button", { name: "确认发送同一交接" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("接收未确认");
    expect(dialog.getByText("失败")).toBeInTheDocument();
    expect(dialog.getByText("尝试 attempt-fixture")).toBeInTheDocument();
    expect(dialog.getByText("回执编号或状态不匹配")).toBeInTheDocument();
    expect(dialog.queryByText(/服务端收到匹配接收回执/)).not.toBeInTheDocument();
    expect(mocked.api.mock.calls.filter(([path]) => path === "handoffs/DH-fixture/send")).toHaveLength(1);
    expect(mocked.api.mock.calls.filter(([path]) => path === "handoffs/DH-fixture")).toHaveLength(2);
    // An error requires an explicit fresh query before the next manual send can be offered.
    expect(dialog.getByRole("button", { name: "重试同一交接" })).toBeDisabled();
    await user.click(dialog.getByRole("button", { name: "重新查询当前记录" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "重试同一交接" })).toBeEnabled());
  });

  it("已接收同时待复核仍保留接收事实，禁止重新发送", async () => {
    const received = handoffDetail({ status: "received", received_at: stamp, needs_review: true,
      review_reasons: ["evidence_revision_changed"], send_eligible: false });
    routes(path => path === "handoffs/DH-fixture" ? received : undefined);
    await ready(); const dialog = await openHandoff();
    expect(dialog.getByText("已接收")).toBeInTheDocument();
    expect(dialog.getByText(/当前需复核：证据修订已变化；历史已接收事实保留/)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "上传产品部门" })).toBeDisabled();
    expect(dialog.getByText(/服务端已有匹配接收回执，不重复发送/)).toBeInTheDocument();
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/send"))).toBe(false);
  });

  it("服务端61组翻到最后一组，排名页保持原UTC窗口与全量统计", async () => {
    const all = Array.from({ length: 61 }, (_, index) => ({ ...overview().groups[0],
      key: `group-${index + 1}`, title: `排名需求${index + 1}`, count: 61 - index }));
    routes(path => {
      if (!path.startsWith("overview?")) return;
      const params = query(path), page = Number(params.get("page") || 1), size = Number(params.get("page_size"));
      expect(size).toBe(20);
      if (page > 1) {
        expect(params.get("window_start")).toBe(start); expect(params.get("window_end")).toBe(stamp);
      }
      return overview({ groups: all.slice((page - 1) * size, page * size), groups_total: 61, page,
        page_size: size, has_more: page * size < 61, counts: { ...overview().counts, groups: 61, occurrences: 1891 } });
    });
    const user = userEvent.setup(); await ready();
    const seen = new Set<string>();
    for (let page = 1; page <= 4; page++) {
      const rows = screen.getAllByRole("row").slice(1);
      expect(rows).toHaveLength(page === 4 ? 1 : 20);
      for (const row of rows) seen.add(within(row).getByText(/^排名需求\d+$/).textContent!);
      if (page < 4) {
        await user.click(screen.getByRole("button", { name: "下一页" }));
        await screen.findByText(`排名需求${page * 20 + 1}`);
      }
    }
    expect(seen.size).toBe(61);
    expect(screen.getByText("排名需求61")).toBeInTheDocument();
    expect(screen.getByText("共 61 条 · 第 4 / 4 页")).toBeInTheDocument();
    expect(screen.getByText("1891")).toBeInTheDocument();
    expect(screen.queryByText(/当前接口只返回前/)).not.toBeInTheDocument();
  });

  it("140条证据必须逐页逐条明确核对，再比对B并提交A完整集合及摘要", async () => {
    const items = manyEvidence(140), baseline = approvalSet(items);
    routes(path => {
      if (path.startsWith("groups/group-one/approval-set?")) return baseline;
      if (path.startsWith("groups/group-one?")) {
        expect(query(path).get("page_size")).toBe("40");
        expect(query(path).get("window_start")).toBe(start); expect(query(path).get("window_end")).toBe(stamp);
        return evidencePage(items, path);
      }
      if (path === "groups/group-one/approve") return {};
    });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "逐条核对140条模拟原话与出处");
    expect(dialog.getAllByRole("checkbox", { name: /已核对原话与出处/ })).toHaveLength(40);
    expect(dialog.getByText("已核对 0 / 140 条有效证据")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    const pager = () => within(dialog.getByRole("navigation", { name: "来源证据分页" }));
    await user.click(pager().getByRole("button", { name: "下一页" }));
    await dialog.findByText("合成原话041");
    expect(dialog.getByText("已核对 0 / 140 条有效证据")).toBeInTheDocument();
    await user.click(pager().getByRole("button", { name: "上一页" }));
    await dialog.findByText("合成原话001");
    for (let page = 1; page <= 4; page++) {
      await checkVisible(dialog, user);
      const reviewed = Math.min(page * 40, 140);
      expect(dialog.getByText(`已核对 ${reviewed} / 140 条有效证据`)).toBeInTheDocument();
      if (page < 4) {
        expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
        await user.click(pager().getByRole("button", { name: "下一页" }));
        await dialog.findByText(`合成原话${String(page * 40 + 1).padStart(3, "0")}`);
      }
    }
    expect(dialog.getAllByRole("checkbox", { name: /已核对原话与出处/ })).toHaveLength(20);
    await user.click(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    await waitFor(() => expect(mocked.api.mock.calls.filter(([path]) => path === "groups/group-one/approve")).toHaveLength(1));
    const calls = mocked.api.mock.calls, writeIndex = calls.findIndex(([path]) => path === "groups/group-one/approve");
    expect(calls.slice(0, writeIndex).filter(([path]) => String(path).startsWith("groups/group-one/approval-set?")).length).toBeGreaterThanOrEqual(2);
    expect(calls[writeIndex][1]).toEqual({ note: "逐条核对140条模拟原话与出处", days: 7,
      expected_occurrence_ids: baseline.expected_occurrence_ids, expected_revisions: baseline.expected_revisions,
      expected_evidence_digest: digest, window_start: start, window_end: stamp });
    expect(baseline.expected_occurrence_ids).toHaveLength(140);
  }, 30000);

  it.each(["集合", "修订", "内容摘要"])("A/B%s变化清除核对且保留理由，不以B替换A自动批准", async kind => {
    let changedAfterReview = false;
    const original = approvalSet(), changed = kind === "集合" ? approvalSet([evidence({ id: "different-id" })])
      : kind === "修订" ? approvalSet([evidence({ revision: 4 })]) : approvalSet(undefined, { evidence_digest: "b".repeat(64) });
    routes(path => {
      if (path.startsWith("groups/group-one/approval-set?")) return changedAfterReview ? changed : original;
    });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "发生变化也保留这个说明");
    await checkVisible(dialog, user);
    changedAfterReview = true;
    await user.click(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    expect(await dialog.findByText(/证据集合或内容已变化/)).toBeInTheDocument();
    expect(dialog.getByRole("textbox")).toHaveValue("发生变化也保留这个说明");
    expect(dialog.getByRole("button", { name: "核验并批准当前证据快照" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "重新开始全部核对" })).toBeInTheDocument();
    expect(dialog.queryByRole("checkbox", { name: /已核对原话与出处/, checked: true })).not.toBeInTheDocument();
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/approve"))).toBe(false);
  });

  it("A/B保持不变但引用来源修订变化时拒绝批准并保留说明", async () => {
    let sourceChanged = false;
    routes(path => {
      if (path === "turns/turn-context") {
        const source = contextTurnDetail();
        return sourceChanged ? { ...source, occurrences: source.occurrences.map(item => ({ ...item, revision: 2 })) } : source;
      }
      if (path === "groups/group-one/approve") return {};
    });
    const user = userEvent.setup(); await ready(); const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "核对过引用证据的说明");
    await checkVisible(dialog, user);
    expect(dialog.getByText("已核对 1 / 1 条有效证据")).toBeInTheDocument();
    sourceChanged = true;
    await user.click(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    expect(await dialog.findByText(/(?:引用|来源|出处).*变化/)).toBeInTheDocument();
    expect(dialog.getByRole("textbox")).toHaveValue("核对过引用证据的说明");
    expect(dialog.queryByRole("checkbox", { name: /已核对原话与出处/, checked: true })).not.toBeInTheDocument();
    expect(mocked.api.mock.calls.filter(([path]) => path === "turns/turn-context").length).toBeGreaterThanOrEqual(2);
    expect(mocked.api.mock.calls.some(([path]) => String(path).endsWith("/approve"))).toBe(false);
  });

  it("累计查询的来源、A/B与批准均保留首页截止，只提交window_end", async () => {
    const end = "2026-10-09T00:00:00.654321Z";
    routes(path => {
      if (path.startsWith("overview?") && query(path).get("days") === "0") return overview({ days: 0, window_start: null, window_end: end });
      if (path.startsWith("groups/group-one/approval-set?")) return approvalSet(undefined, { days: 0, window_start: null, window_end: end });
      if (path.startsWith("groups/group-one?")) return groupDetail({ window_start: null, window_end: end });
      if (path === "groups/group-one/approve") return {};
    });
    const user = userEvent.setup(); await ready();
    await user.selectOptions(screen.getByLabelText("统计时间范围"), "0");
    await waitFor(() => expect(screen.getByRole("button", { name: /查看与审核/ })).toBeEnabled());
    const dialog = await openGroup(user);
    await user.type(await dialog.findByRole("textbox"), "累计全部核对"); await checkVisible(dialog, user);
    await user.click(dialog.getByRole("button", { name: "核验并批准当前证据快照" }));
    await waitFor(() => expect(mocked.api.mock.calls.some(([path]) => path === "groups/group-one/approve")).toBe(true));
    const reads = mocked.api.mock.calls.filter(([path]) => String(path).startsWith("groups/group-one?") || String(path).startsWith("groups/group-one/approval-set?"));
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const [path] of reads) {
      expect(query(path).get("days")).toBe("0"); expect(query(path).get("window_end")).toBe(end); expect(query(path).has("window_start")).toBe(false);
    }
    const body = mocked.api.mock.calls.find(([path]) => path === "groups/group-one/approve")?.[1] as Record<string, unknown>;
    expect(body.days).toBe(0); expect(body.window_end).toBe(end); expect(body.window_start ?? null).toBeNull();
  });

  it("历史概要采用冻结标题及group_key，缺标题显示未记录而不套用当前榜单", async () => {
    const frozen = handoffDetail({ title: "冻结的旧需求标题", group_key: "frozen-group" });
    const missing = handoffDetail({ id: "DH-missing-title", title: null, group_key: "legacy-group" });
    routes(path => {
      if (path.startsWith("overview?")) return overview({ groups: [{ ...overview().groups[0], title: "当前新需求标题", handoff: frozen }] });
      if (path.startsWith("handoffs?")) return paged([frozen, missing]);
    });
    const user = userEvent.setup(); await ready();
    await user.click(within(screen.getByRole("navigation", { name: "后台栏目" })).getByRole("button", { name: "审批与交接" }));
    expect(await screen.findByText("冻结的旧需求标题")).toBeInTheDocument();
    expect(screen.getByText("历史标题未记录")).toBeInTheDocument();
    expect(screen.queryByText("当前新需求标题")).not.toBeInTheDocument();
    expect(mocked.api.mock.calls.some(([path]) => path === "handoffs/DH-fixture")).toBe(false);
  });
});
