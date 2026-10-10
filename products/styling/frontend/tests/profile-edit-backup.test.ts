import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_PROFILE_DRAFT } from "../app/lib/profile-draft";
import { profileEditOwner, readProfileEditBackup, removeProfileEditBackup, writeProfileEditBackup, type ProfileEditOwner } from "../app/lib/profile-edit-backup";
import { parseConsumerProfile } from "../app/lib/consumer-profile";
import { emptyConsumerProfile } from "./consumer-test-routes";

const owner: ProfileEditOwner = { scope_kind: "device", context_id: "synthetic-context-a" };
const draft = () => ({ profileVersion: 0, message: "仅供合成恢复测试的未发送原话", profileDraft: { ...EMPTY_PROFILE_DRAFT, top: "S" }, ownedProfileLine: null,
  panel: { editing: { ...EMPTY_PROFILE_DRAFT, top: "L" }, touched: ["top" as const] } });
beforeEach(() => sessionStorage.clear());

describe("按授权范围隔离的未保存编辑备份", () => {
  it("只读取相同scope和context的备份，不扫描其他身份或返回token", () => {
    expect(writeProfileEditBackup(owner, draft())).toBe(true);
    expect(readProfileEditBackup({ ...owner })).toEqual({ owner, ...draft() });
    expect(readProfileEditBackup({ ...owner, context_id: "synthetic-context-b" })).toBeNull();
    expect(readProfileEditBackup({ ...owner, scope_kind: "user" })).toBeNull();
    expect(readProfileEditBackup(null)).toBeNull(); expect(writeProfileEditBackup(null, draft())).toBe(false);
    expect(sessionStorage.length).toBe(1);
  });
  it("仅从完整合法GET取得不含token的owner，旧schema没有可恢复范围", () => {
    const old = parseConsumerProfile(emptyConsumerProfile);
    expect(profileEditOwner(old)).toBeNull();
    const profile = parseConsumerProfile({ ...emptyConsumerProfile, authorization_context: { context_contract: "consumer_profile_mutation_context_v1", context_id: owner.context_id,
      operation_token: "synthetic-private-token-never-in-backup", issued_at: "2026-10-10T00:00:00Z", expires_at: "2026-10-10T00:10:00Z" } });
    expect(profileEditOwner(profile)).toEqual(owner);
    writeProfileEditBackup(profileEditOwner(profile), draft());
    const stored = sessionStorage.getItem(sessionStorage.key(0)!)!;
    expect(stored).not.toContain("operation_token"); expect(stored).not.toContain("synthetic-private-token");
  });
  it("写入只保留允许的草稿字段，数组与对象不保留调用方引用", () => {
    const data = { ...draft(), operation_token: "must-not-copy", expected_authorization_context: "must-not-copy" };
    writeProfileEditBackup(owner, data);
    data.panel.editing.top = "XL";
    expect(readProfileEditBackup(owner)?.panel?.editing.top).toBe("L");
    const stored = sessionStorage.getItem(sessionStorage.key(0)!)!;
    expect(stored).not.toContain("must-not-copy");
  });
  it("拒绝损坏、跨scope、未知字段和不在原话中的受控行，不发明恢复数据", () => {
    writeProfileEditBackup(owner, draft()); const key = sessionStorage.key(0)!;
    for (const invalid of ["not-json", JSON.stringify({ owner, ...draft(), operation_token: "unexpected" }), JSON.stringify({ owner: { ...owner, scope_kind: "user" }, ...draft() }), JSON.stringify({ owner, ...draft(), ownedProfileLine: "不存在的资料行" })]) {
      sessionStorage.setItem(key, invalid); expect(readProfileEditBackup(owner)).toBeNull();
    }
  });
  it("明确清空当前编辑或丢弃只移除当前范围，另一份备份保持", () => {
    const other: ProfileEditOwner = { ...owner, context_id: "synthetic-context-b" };
    writeProfileEditBackup(owner, draft()); writeProfileEditBackup(other, draft());
    writeProfileEditBackup(owner, { profileVersion: 0, message: "", profileDraft: { ...EMPTY_PROFILE_DRAFT }, ownedProfileLine: null, panel: null });
    expect(readProfileEditBackup(owner)).toBeNull(); expect(readProfileEditBackup(other)).not.toBeNull();
    expect(removeProfileEditBackup(other)).toBe(true); expect(sessionStorage.length).toBe(0);
  });
});
