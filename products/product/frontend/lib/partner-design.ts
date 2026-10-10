import { randomUUID } from "node:crypto";
import { partnerDatabase, transaction } from "./partner-store";
import { authorizeService, readPartnerConfig } from "./handoff-auth";
import { validateDesignEvent, parseStrictJson } from "./partner-protocol";
import { digest, object, readBounded, getDetail, WorkbenchError } from "./partner-workflow";
import { recheckPerson, type PersonSession } from "./auth";
type Obj = Record<string, unknown>;
type PackageRow = {
    case_id: string;
    content: Uint8Array;
    digest: string;
    delivery: string;
};
export function listDeliveries(request: Request) {
    const service = authorizeService(request, "design_package_reader");
    const scope = service.authorized_scope;
    const query = new URL(request.url).searchParams;
    const packageId = query.get("package_id"), version = query.get("version");
    if (Boolean(packageId) !== Boolean(version) || packageId && query.has("cursor"))
        throw new WorkbenchError("INVALID_INPUT", "包编号与版本必须同时指定");
    if (packageId) {
        const row = partnerDatabase().prepare("SELECT delivery FROM partner_packages WHERE scope=? AND package_id=? AND version=? AND json_extract(delivery,'$.source_instance_id')=? AND json_extract(delivery,'$.target_instance_id')=?").get(scope, packageId, version!, service.target_instance_id, service.source_instance_id) as {
            delivery: string;
        } | undefined;
        if (!row)
            throw new WorkbenchError("NOT_FOUND", "未找到已批准包", 404);
        return { delivery_schema: "pa-design-list/2", items: [JSON.parse(row.delivery)], next_cursor: null };
    }
    const cursor = query.get("cursor") ?? "0", limit = query.get("limit") ?? "50";
    if (!/^\d+$/.test(cursor) || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50 || !Number.isSafeInteger(Number(cursor)))
        throw new WorkbenchError("INVALID_INPUT", "分页参数不正确");
    const rows = partnerDatabase().prepare("SELECT rowid,delivery FROM partner_packages WHERE scope=? AND rowid>? AND json_extract(delivery,'$.source_instance_id')=? AND json_extract(delivery,'$.target_instance_id')=? ORDER BY rowid LIMIT ?").all(scope, Number(cursor), service.target_instance_id, service.source_instance_id, Number(limit) + 1) as {
        rowid: number;
        delivery: string;
    }[];
    const selected: typeof rows = [];
    let bytes = 200;
    for (const row of rows) {
        if (selected.length === Number(limit) || bytes + Buffer.byteLength(row.delivery) > 16 * 1024 * 1024 - 1024)
            break;
        selected.push(row);
        bytes += Buffer.byteLength(row.delivery) + 1;
    }
    return { delivery_schema: "pa-design-list/2", items: selected.map(x => JSON.parse(x.delivery)), next_cursor: rows.length > selected.length ? String(selected.at(-1)!.rowid) : null };
}
export function queryEvent(request: Request) {
    const s = authorizeService(request, "design_event_writer");
    const eventId = new URL(request.url).searchParams.get("event_id");
    if (!eventId)
        throw new WorkbenchError("INVALID_INPUT", "缺少事件编号");
    const row = partnerDatabase().prepare("SELECT receipt FROM partner_events WHERE scope=? AND event_id=? AND json_extract(event,'$.source_instance_id')=? AND json_extract(event,'$.target_instance_id')=?").get(s.authorized_scope, eventId, s.source_instance_id, s.target_instance_id) as {
        receipt: string;
    } | undefined;
    if (!row)
        throw new WorkbenchError("NOT_FOUND", "未找到事件", 404);
    return { receipt: JSON.parse(row.receipt) };
}
function storedEvent(scope: string, eventId: string) {
    return partnerDatabase().prepare("SELECT raw,content,receipt,event FROM partner_events WHERE scope=? AND event_id=?").get(scope, eventId) as {
        raw: Uint8Array;
        content: Uint8Array;
        receipt: string;
        event: string;
    } | undefined;
}
function approvedPackage(scope: string, event: Obj): PackageRow {
    const row = partnerDatabase().prepare("SELECT case_id,content,digest,delivery FROM partner_packages WHERE scope=? AND package_id=? AND version=?").get(scope, String(event.package_id), String(event.version)) as PackageRow | undefined;
    if (!row)
        throw new WorkbenchError("NOT_FOUND", "未找到对应批准版本", 404);
    const pkg = object(parseStrictJson(row.content));
    const current = readPartnerConfig();
    if (pkg.source_instance_id !== current.instance_id || pkg.target_instance_id !== current.design_instance_id || pkg.authorized_scope !== scope)
        throw new WorkbenchError("NOT_FOUND", "未找到当前配对版本", 404);
    if (event.package_content_digest !== row.digest || event.version_group_id !== pkg.version_group_id || event.requirement_digest !== pkg.requirement_digest || event.prompt_digest !== pkg.prompt_digest)
        throw new WorkbenchError("PACKAGE_CONFLICT", "事件与批准版本不一致", 409);
    const existing = partnerDatabase().prepare("SELECT event FROM partner_events WHERE scope=? AND case_id=?").all(scope, row.case_id) as {
        event: string;
    }[];
    let confirmed = false;
    for (const e of existing) {
        const value = JSON.parse(e.event);
        if (value.kind === "received" && value.package_id === event.package_id && value.version === event.version && value.design_receive_id === event.design_receive_id)
            confirmed = true;
        if (value.package_id === event.package_id && value.version === event.version && value.design_receive_id !== event.design_receive_id)
            throw new WorkbenchError("EVENT_CONFLICT", "设计收件身份不一致", 409);
    }
    if (event.kind !== "received" && !confirmed)
        throw new WorkbenchError("RECEIPT_NOT_CONFIRMED", "请先回告设计接收", 409);
    return row;
}
async function designFetch(eventId: string, assetId?: string) {
    const cfg = readPartnerConfig() as unknown as Obj;
    const rawBase = cfg.design_asset_base_url;
    if (typeof rawBase !== "string")
        throw new WorkbenchError("NOT_CONFIGURED", "设计结果读取尚未配置", 503);
    const url = new URL(rawBase);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/")
        throw new WorkbenchError("NOT_CONFIGURED", "设计读取地址不合法", 503);
    const token = cfg.design_asset_reader_token;
    if (typeof token !== "string" || token.length < 32)
        throw new WorkbenchError("NOT_CONFIGURED", "设计结果读取尚未配置", 503);
    const path = `/api/design-integration/events/${encodeURIComponent(eventId)}/${assetId ? `assets/${encodeURIComponent(assetId)}` : "review"}`;
    try {
        const response = await fetch(url.origin + path, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) });
        if (!response.ok)
            throw new WorkbenchError("UPSTREAM_UNAVAILABLE", "设计结果暂不可读取", 502, true);
        return response;
    }
    catch (e) {
        if (e instanceof WorkbenchError)
            throw e;
        throw new WorkbenchError("UPSTREAM_UNAVAILABLE", "设计结果服务暂不可用", 502, true);
    }
}
export async function receiveEvent(request: Request, raw: Uint8Array) {
    const service = authorizeService(request, "design_event_writer");
    const decoded = validateDesignEvent(raw, { source_instance_id: service.source_instance_id, target_instance_id: service.target_instance_id, authorized_scope: service.authorized_scope });
    const { envelope, event, content } = decoded;
    const id = String(event.event_id), scope = service.authorized_scope;
    if (request.headers.get("idempotency-key") !== id)
        throw new WorkbenchError("INVALID_INPUT", "事件幂等键不匹配");
    const prior = storedEvent(scope, id);
    if (prior) {
        if (!Buffer.from(prior.content).equals(content))
            throw new WorkbenchError("EVENT_CONFLICT", "同编号事件原文不同", 409);
        return { status: 200, body: { receipt: JSON.parse(prior.receipt), duplicate: true } };
    }
    approvedPackage(scope, event);
    if (event.kind === "design_approved") {
        const proofResponse = await designFetch(id);
        const proof = object(parseStrictJson(await readBounded(proofResponse, 3 * 1024 * 1024)));
        if (Object.keys(proof).sort().join() !== ["event_schema", "event_id", "event_revision", "content_digest", "content_base64"].sort().join() || proof.event_schema !== event.event_schema || proof.event_id !== id || proof.event_revision !== event.event_revision || proof.content_digest !== envelope.content_digest || proof.content_base64 !== envelope.content_base64)
            throw new WorkbenchError("EVENT_CONFLICT", "设计审查冻结原件不一致", 409);
    }
    return transaction(db => {
        const currentService = authorizeService(request, "design_event_writer");
        if (JSON.stringify(currentService) !== JSON.stringify(service))
            throw new WorkbenchError("FORBIDDEN", "服务配对已变化", 403);
        const existing = storedEvent(scope, id);
        if (existing) {
            if (!Buffer.from(existing.content).equals(content))
                throw new WorkbenchError("EVENT_CONFLICT", "同编号事件原文不同", 409);
            return { status: 200, body: { receipt: JSON.parse(existing.receipt), duplicate: true } };
        }
        const pkg = approvedPackage(scope, event);
        const receipt = { receipt_schema: "pa-design-event-receipt/2", event_receive_id: `EVRCV-${randomUUID()}`, event_id: id, event_revision: 1, source_instance_id: service.source_instance_id, target_instance_id: service.target_instance_id, authorized_scope: scope, content_digest: envelope.content_digest, package_id: event.package_id, version: event.version, status: "received", received_at: new Date().toISOString() };
        db.prepare("INSERT INTO partner_events VALUES(?,?,?,?,?,?,?)").run(scope, id, pkg.case_id, Buffer.from(raw), Buffer.from(content), JSON.stringify(event), JSON.stringify(receipt));
        const row = db.prepare("SELECT record FROM partner_cases WHERE scope=? AND id=?").get(scope, pkg.case_id) as {
            record: string;
        } | undefined;
        if (row) {
            const c = JSON.parse(row.record);
            if (c.package_id === event.package_id && c.package_version === event.version) {
                c.transport_status = "received";
                db.prepare("UPDATE partner_cases SET record=? WHERE scope=? AND id=?").run(JSON.stringify(c), scope, pkg.case_id);
            }
        }
        return { status: 201, body: { receipt, duplicate: false } };
    });
}
export async function readAsset(s: PersonSession, eventId: string, assetId: string) {
    const row = storedEvent(s.context.scope, eventId);
    if (!row)
        throw new WorkbenchError("NOT_FOUND", "未找到可访问结果", 404);
    const event = object(JSON.parse(row.event));
    const pkg = approvedPackage(s.context.scope, event);
    await getDetail(s, pkg.case_id);
    if (event.kind !== "design_approved")
        throw new WorkbenchError("NOT_FOUND", "未找到已批准资源", 404);
    const result = object(event.result);
    const assets = result.assets as Obj[];
    const asset = assets.find(x => x.asset_id === assetId);
    if (!asset)
        throw new WorkbenchError("NOT_FOUND", "未找到已批准资源", 404);
    const response = await designFetch(eventId, assetId);
    const bytes = await readBounded(response, 10 * 1024 * 1024);
    const mime = response.headers.get("content-type")?.split(";")[0];
    const magic = bytes.subarray(0, 12);
    const valid = (mime === "image/png" && magic.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) || (mime === "image/jpeg" && magic[0] === 255 && magic[1] === 216 && magic[2] === 255) || (mime === "image/webp" && magic.subarray(0, 4).toString() === "RIFF" && magic.subarray(8, 12).toString() === "WEBP");
    if (!valid || mime !== asset.mime_type || digest(bytes) !== asset.sha256)
        throw new WorkbenchError("ASSET_MISMATCH", "资源摘要或类型不一致", 502);
    recheckPerson(s);
    await getDetail(s, pkg.case_id);
    return new Response(bytes, { headers: { "Content-Type": mime!, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Content-SHA256": String(asset.sha256) } });
}
