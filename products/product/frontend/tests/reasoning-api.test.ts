import {afterEach,describe,expect,it,vi} from 'vitest';
import {reasoningApi,encodeInput,decodeInput,validateAnalysis} from '@/features/reasoning-workbench/api';
import {detail,identity,analysis,list,batch} from './reasoning-client-fixtures';
import {sceneLabel} from "@/features/reasoning-workbench/input-view";
afterEach(()=>vi.unstubAllGlobals());
describe('研判实际客户端传输/DTO边界',()=>{
 it.each([200,201])('HTTP%s写入回执损坏进入未知恢复，保留原请求，不继续新action',async(status)=>{const fetch=vi.fn().mockResolvedValue(new Response('{malformed',{status}));vi.stubGlobal('fetch',fetch);const raw=JSON.stringify({action_id:'ORIGINAL-ACTION',action:'analyze'});await expect(reasoningApi.act(detail.task.task_id,raw,identity)).rejects.toMatchObject({status:502,code:'RESPONSE_UNKNOWN'});expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][1].body).toBe(raw);});
 it('200但契约/准确版不一致报502，写入同样需要对账',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({...detail,analysis:{...analysis,input_digest:'f'.repeat(64)}}))));await expect(reasoningApi.act(detail.task.task_id,'original',identity)).rejects.toMatchObject({status:502,code:'INVALID_RESPONSE'});});
 it('只POST新研判接口、同体、CSRF和当前人员cookie，不调用旧approve',async()=>{const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(detail)));vi.stubGlobal('fetch',fetch);await reasoningApi.act(detail.task.task_id,'ORIGINAL',identity);expect(fetch.mock.calls[0][0]).toBe('/api/workbench/reasoning/tasks/TASK-C/actions');expect(fetch.mock.calls[0][1]).toMatchObject({credentials:'same-origin',cache:'no-store',method:'POST',body:'ORIGINAL',headers:{'X-CSRF-Token':identity.csrf_token}});});
 it('员工收到其他人的任务拒绝显示，不能借demo看全scope',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({...list,tasks:[{...detail.task,assignee:'another-worker'}]}))));await expect(reasoningApi.list(identity)).rejects.toMatchObject({status:403});});
 it('输入语境冲突422不误判人员上下文失效',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'CONTEXT_CONFLICT',message:'输入语境冲突'}}),{status:422})));await expect(reasoningApi.import('original',identity)).rejects.toMatchObject({status:422,code:'CONTEXT_CONFLICT'});});
 it('完整中文输入字节可以往返base64，不读独立验收答案',()=>{const raw=JSON.stringify(batch,null,2);expect(decodeInput(encodeInput(raw))).toBe(raw);expect(sceneLabel("leisure")).toBe("休闲");});
 it('拒绝缺角色计数、缺完整原因和虚构可直接设计的响应',()=>{expect(()=>validateAnalysis({...analysis,result:{...analysis.result,groups:[{...analysis.result.groups[0],counts:undefined}]}})).toThrow();expect(()=>validateAnalysis({...analysis,result:{...analysis.result,groups:[{...analysis.result.groups[0],proposed_action:{...analysis.result.groups[0].proposed_action,design_ready:true}}]}})).toThrow();});
});
