// @vitest-environment node
// Isolated persisted projection fixtures; real read routes, no external services or model calls.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate, createSession, hashPassword } from "@/lib/auth";
import { partnerDatabase } from "@/lib/partner-store";
import { validateDesignEvent, sha256 } from "@/lib/partner-protocol";
import { GET as history } from "@/app/api/workbench/history/route";
import { GET as list } from "@/app/api/workbench/signals/route";
import { GET as detail } from "@/app/api/workbench/case/route";
vi.mock("server-only", () => ({}));
const origin="http://127.0.0.1:3091", scope="pagination-scope", caseId="SIG-DH-page-fixture", max=16*1024*1024;
const pair={source_instance_id:"design-test",target_instance_id:"product-test",authorized_scope:scope};
let directory:string, staffToken:string, managerToken:string;
const bytes=(v:unknown)=>Buffer.from(JSON.stringify(v));
const time=(n:number)=>new Date(Date.UTC(2026,9,10,0,0,n)).toISOString();
const req=(token:string,path:string)=>new Request(origin+path,{headers:{cookie:`zhixu_session=${token}`}});
function seedCase(id=caseId,assignee="staff") {
 const signal={schema_version:"pa-styling-signal/2",signal_id:id,authorized_scope:scope,evidence_projection:[]};
 const record={signal_id:id,status:"assigned",assignee,draft:"",note:"",updated_at:time(0),case_revision:1,assignment_id:"ASSIGN-page",assignment_version:1,version_group_id:null,requirement_version:0,prompt_version:0,requirement_digest:null,prompt_digest:null,submission_id:null,package_id:null,package_version:null,transport_status:"not_approved",allowed_actions:[]};
 partnerDatabase().prepare("INSERT INTO partner_cases VALUES(?,?,?,?)").run(scope,id,JSON.stringify(record),JSON.stringify(signal));
 return signal;
}
function event(n:number,large=false):Record<string,unknown> {
 const e:Record<string,unknown>={event_schema:"pa-design-event/2",event_id:`event-${n}`,event_revision:1,kind:"received",source_product:"footwear_design",target_product:"product_management",...pair,created_at:time(n),package_id:"PKG-WB-page",version:"v1",package_content_digest:"a".repeat(64),design_receive_id:"design-receive-page",version_group_id:"VG-page",requirement_digest:"b".repeat(64),prompt_digest:"c".repeat(64),note:"",clarification:null,result:null,design_receipt:{receipt_schema:"pa-design-receipt/2",design_receive_id:"design-receive-page",source_instance_id:"product-test",target_instance_id:"design-test",authorized_scope:scope,package_id:"PKG-WB-page",version:"v1",content_digest:"a".repeat(64),status:"received",received_at:time(n)}};
 if(large){
  const assets=Array.from({length:4200},(_,i)=>({asset_id:`asset-${i}`,sha256:"d".repeat(64),mime_type:"image/png",width:16,height:16,origin:"synthetic_fixture"}));
  const v={schema_version:"pa-design-result-version/2",design_version_id:`DV-${n}`,task_id:"design-task",assignment_id:"design-assignment",design_receive_id:e.design_receive_id,package_id:e.package_id,package_version:e.version,package_content_digest:e.package_content_digest,version_group_id:e.version_group_id,requirement_digest:e.requirement_digest,prompt_digest:e.prompt_digest,assets,summary:"合成技术结果",changes:"",checks:[],unknowns:[],generation_mode:"synthetic_fixture",created_by:"design-staff",created_at:time(0)};
  const raw=bytes(v); e.kind="design_approved";e.design_receipt=null;e.note="n".repeat(10000);
  e.result={task_id:v.task_id,assignment_id:v.assignment_id,submission_id:`design-submission-${n}`,design_version_id:v.design_version_id,design_version_digest:sha256(raw),design_version_base64:raw.toString("base64"),assets,summary:v.summary,changes:v.changes,checks:[],unknowns:[],generation_mode:"synthetic_fixture",review:{review_id:`review-${n}`,manager_subject:"design-manager",approved_at:time(1),decision:"approved",submission_id:`design-submission-${n}`,design_version_id:v.design_version_id,design_version_digest:sha256(raw)}};
  expect(bytes(e).length).toBeGreaterThan(1024*1024);expect(bytes(e).length).toBeLessThan(2*1024*1024);
 }
 return e;
}
function store(e:Record<string,unknown>,n:number,id=caseId){
 const raw=bytes(e),envelope={delivery_schema:"pa-design-event-delivery/2",source_product:"footwear_design",target_product:"product_management",...pair,event_id:e.event_id,event_revision:1,content_digest:sha256(raw),content_base64:raw.toString("base64")};
 validateDesignEvent(bytes(envelope),pair);
 partnerDatabase().prepare("INSERT INTO partner_events VALUES(?,?,?,?,?,?,?)").run(scope,String(e.event_id),id,bytes(envelope),raw,JSON.stringify(e),JSON.stringify({received_at:time(n)}));
}
beforeEach(()=>{
 directory=mkdtempSync(join(tmpdir(),"partner-pagination-isolated-"));const file=join(directory,"config.json");
 writeFileSync(file,JSON.stringify({instance_id:"product-test",design_instance_id:"design-test",authorized_scope:scope,origin,backend_url:"http://127.0.0.1:8091",backend_reader_token:"synthetic-reader-"+"r".repeat(40),services:[]}),{mode:0o600});
 vi.stubEnv("WORKBENCH_CONFIG_FILE",file);vi.stubEnv("WORKBENCH_USERS_DB",join(directory,"identities.sqlite"));vi.stubEnv("WORKBENCH_CASES_DB",join(directory,"cases.sqlite"));vi.stubEnv("WORKBENCH_SESSION_SECRET","synthetic-pagination-"+"s".repeat(40));
 const hash=hashPassword("Synthetic-Password-42");for(const role of ["STAFF","MANAGER"]){vi.stubEnv(`WORKBENCH_${role}_USERNAME`,role.toLowerCase());vi.stubEnv(`WORKBENCH_${role}_PASSWORD_HASH`,hash);vi.stubEnv(`WORKBENCH_${role}_ENABLED`,"true");}
 staffToken=createSession(authenticate("staff","Synthetic-Password-42")!);managerToken=createSession(authenticate("manager","Synthetic-Password-42")!);seedCase();
 vi.stubGlobal("fetch",vi.fn(()=>{throw new Error("Unexpected network in pagination test");}));
});
afterEach(()=>{try{partnerDatabase().close();}finally{vi.unstubAllEnvs();vi.unstubAllGlobals();rmSync(directory,{recursive:true,force:true});}});
async function page(token=staffToken,query=""){
 const response=await history(req(token,`/api/workbench/history?id=${caseId}${query}`));const raw=await response.text();expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(max);return{status:response.status,body:JSON.parse(raw)};
}
describe("bounded event presentation and recoverable history",()=>{
 it("returns latest 50 of 75 and continues a frozen snapshot without repeats",async()=>{
  for(let i=1;i<=75;i++)store(event(i),i);
  const first=await page();expect(first.status).toBe(200);expect(first.body.events).toHaveLength(50);expect(first.body.events[0].event_id).toBe("event-75");expect(first.body.has_more).toBe(true);store(event(76),76);
  const second=await page(staffToken,`&cursor=${encodeURIComponent(first.body.next_cursor)}`);expect(second.status).toBe(200);expect(second.body.events).toHaveLength(25);expect(second.body.next_cursor).toBeNull();
  expect(new Set([...first.body.events,...second.body.events].map(e=>e.event_id)).size).toBe(75);expect((await page()).body.events[0].event_id).toBe("event-76");
 });
 it("bounds list/detail summaries and preserves the signal continuation",async()=>{
  for(let i=1;i<=70;i++)store(event(i),i);
  const l=await list(req(staffToken,"/api/workbench/signals")),lb=await l.json();expect(l.status).toBe(200);expect(lb.design_events).toHaveLength(50);expect(lb.design_events_has_more).toBe(true);expect(lb.next_cursor).toBeNull();
  const d=await detail(req(staffToken,`/api/workbench/case?id=${caseId}`)),db=await d.json();expect(d.status).toBe(200);expect(db.events).toHaveLength(50);expect(db.events_has_more).toBe(true);expect(db.events[0].history_ref).toEqual({id:caseId,record_type:"events",record_id:"event-70"});
 });
 it("pages legal large events below 16MiB and retrieves exact originals",async()=>{
  let firstEvent;for(let i=2;i<16;i++){const e=event(i,true);firstEvent??=e;store(e,i);}
  const first=await page();expect(first.status).toBe(200);expect(first.body.has_more).toBe(true);expect(first.body.events.length).toBeGreaterThan(0);expect(first.body.events.length).toBeLessThan(14);
  const second=await page(staffToken,`&cursor=${encodeURIComponent(first.body.next_cursor)}`);expect(second.status).toBe(200);expect(second.body.has_more).toBe(false);expect(new Set([...first.body.events,...second.body.events].map(e=>e.event_id)).size).toBe(14);
  const exact=await page(staffToken,"&record_type=events&record_id=event-2");expect(exact.status).toBe(200);expect(exact.body.events).toEqual([firstEvent]);
  const d=await detail(req(staffToken,`/api/workbench/case?id=${caseId}`)),body=await d.json();expect(d.status).toBe(200);expect(body.events[0].note.length).toBe(500);expect(body.events[0].note_truncated).toBe(true);expect(body.events[0].assets).toHaveLength(4);expect(body.events[0].assets_has_more).toBe(true);
 });
 it("hides manager decisions and rejects cross-case exact reads",async()=>{
  store(event(1),1);seedCase("SIG-DH-other","someone-else");store(event(2),2,"SIG-DH-other");
  partnerDatabase().prepare("INSERT INTO partner_decisions VALUES(?,?,?,?)").run(scope,"DEC-page",caseId,JSON.stringify({decision_id:"DEC-page",approved_at:time(3)}));
  expect((await page()).body.decisions).toEqual([]);expect((await page(managerToken)).body.decisions).toHaveLength(1);expect((await page(staffToken,"&record_type=decisions&record_id=DEC-page")).status).toBe(404);expect((await page(staffToken,"&record_type=events&record_id=event-2")).status).toBe(404);
  expect((await history(req(staffToken,"/api/workbench/history?id=SIG-DH-other&record_type=events&record_id=event-2"))).status).toBe(404);
 });
 it("rejects tampered, cross-session, cross-role and invalid pagination",async()=>{
  store(event(1),1);store(event(2),2);const first=await page(staffToken,"&limit=1");expect(first.body.events).toHaveLength(1);
  for(const query of ["&limit=0","&limit=51","&limit=1.5","&cursor=bad","&record_type=events","&record_type=events&record_id=event-1&limit=1",`&cursor=${encodeURIComponent(first.body.next_cursor+"x")}`])expect((await page(staffToken,query)).status).toBe(422);
  expect((await page(managerToken,`&cursor=${encodeURIComponent(first.body.next_cursor)}`)).status).toBe(422);
  const renewed=createSession(authenticate("staff","Synthetic-Password-42")!);expect((await page(renewed,`&cursor=${encodeURIComponent(first.body.next_cursor)}`)).status).toBe(422);
 });
 it("paginates all history kinds together and retrieves every original kind",async()=>{
  const objects=[{table:"partner_versions",kind:"versions",key:"VG-page",data:{version_group_id:"VG-page",created_at:time(4),original:"kept"}},{table:"partner_submissions",kind:"submissions",key:"SUB-page",data:{submission_id:"SUB-page",submitted_at:time(3)}},{table:"partner_decisions",kind:"decisions",key:"DEC-page",data:{decision_id:"DEC-page",approved_at:time(2)}}];
  for(const o of objects){const values=o.kind==="versions"?[scope,caseId,o.key,JSON.stringify(o.data)]:[scope,o.key,caseId,JSON.stringify(o.data)];partnerDatabase().prepare(`INSERT INTO ${o.table} VALUES(?,?,?,?)`).run(...values);}store(event(1),1);
  const first=await page(managerToken,"&limit=2");expect(first.body.versions).toHaveLength(1);expect(first.body.submissions).toHaveLength(1);expect(first.body.decisions).toHaveLength(0);
  const second=await page(managerToken,`&limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);expect(second.body.decisions).toHaveLength(1);expect(second.body.events).toHaveLength(1);expect(second.body.has_more).toBe(false);
  for(const o of objects)expect((await page(managerToken,`&record_type=${o.kind}&record_id=${o.key}`)).body[o.kind]).toEqual([o.data]);
 });
});
