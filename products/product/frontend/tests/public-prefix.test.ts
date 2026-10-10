// @vitest-environment node
import {afterEach,describe,expect,it,vi} from "vitest";
import {NextRequest} from "next/server";
import {isRedirectError} from "next/dist/client/components/redirect-error";
import {getURLFromRedirectError} from "next/dist/client/components/redirect";
import {addPathPrefix} from "next/dist/shared/lib/router/utils/add-path-prefix";
import {appPath} from "@/lib/app-path";
import StaffDemo from "@/app/demo/staff/page";
import ManagerDemo from "@/app/demo/manager/page";
import HomePage from "@/app/page";
import {workbenchApi,type Identity} from "@/features/series-workbench/api";
import {reasoningApi} from "@/features/reasoning-workbench/api";
import {identity} from "./series-fixtures";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
const origin="https://s357brv8j8f9gdhvbu9a9.apigateway-cn-beijing.volceapi.com";
afterEach(()=>vi.unstubAllEnvs());
afterEach(()=>vi.unstubAllGlobals());
describe.each(["","/v2/product"])("产品部署路径 %s",base=>{
 it("自身path只加一次，含query/hash的根也不重复；外链/blob/锚点保持",()=>{vi.stubEnv("NEXT_PUBLIC_BASE_PATH",base);expect(appPath("/api/auth/me")).toBe(`${base}/api/auth/me`);expect(appPath(`${base}/workbench?demo_role=manager#version`)).toBe(`${base}/workbench?demo_role=manager#version`);if(base)expect(appPath(`${base}?demo_role=manager`)).toBe(`${base}?demo_role=manager`);for(const url of ["#version","https://example.test/img","//example.test/img","blob:authorized"])expect(appPath(url)).toBe(url);});
 it.each([[StaffDemo,"staff"],[ManagerDemo,"manager"]] as const)("角色%s服务端redirect交Next自动加prefix，绝不手动再加",(entry,role)=>{vi.stubEnv("NEXT_PUBLIC_BASE_PATH",base);let error:unknown;try{entry();}catch(cause){error=cause;}if(!isRedirectError(error))throw new Error("没有产生Next redirect错误");const target=getURLFromRedirectError(error);expect(target).toBe(`/api/auth/demo?demo_role=${role}`);expect(addPathPrefix(target!,base)).toBe(`${base}/api/auth/demo?demo_role=${role}`);});
 it("默认入口及显式经理query保持，框架只加一次prefix",async()=>{vi.stubEnv("NEXT_PUBLIC_BASE_PATH",base);for(const role of [undefined,"manager"]){let error:unknown;try{await HomePage({searchParams:Promise.resolve({demo_role:role})});}catch(cause){error=cause;}if(!isRedirectError(error))throw new Error("没有产生Next redirect错误");const target=getURLFromRedirectError(error);expect(addPathPrefix(target!,base)).toBe(`${base}/workbench${role?"?demo_role=manager":""}`);}});
 it("真实NextURL去掉basePath后交给Proxy分类，API和页面不是404旧路由",()=>{for(const path of ["/workbench","/team","/api/auth/me","/api/workbench/signals","/api/workbench/reasoning/tasks","/api/workbench/design-assets/E/A","/api/design-link/packages"]){const request=new NextRequest(`${origin}${base}${path}`,{nextConfig:{basePath:base}});expect(request.nextUrl.pathname).toBe(path);expect(request.nextUrl.basePath).toBe(base);}});
 it("现人员/研判API实际fetch全部落本产品prefix，原role/CSRF/body不变",async()=>{vi.stubEnv("NEXT_PUBLIC_BASE_PATH",base);const fetch=vi.fn(async()=>new Response(JSON.stringify({error:{code:"TEST",message:"合成拒绝"}}),{status:503}));vi.stubGlobal("fetch",fetch);const person:Identity={...identity,user:{...identity.user,role:"manager"},access:{...identity.access,role:"manager"}};await Promise.allSettled([workbenchApi.me(undefined,"manager"),workbenchApi.read(undefined,undefined,"manager"),workbenchApi.detail("CASE",undefined,"manager"),workbenchApi.history("CASE",undefined,{},"manager"),workbenchApi.act("ORIGINAL",person),workbenchApi.action("ACTION",person),workbenchApi.preview("CASE",1,"裤子",person),workbenchApi.logout(person),workbenchApi.invite(person),reasoningApi.list(person),reasoningApi.detail("TASK",person),reasoningApi.sample(person),reasoningApi.history("TASK",person),reasoningApi.import("ORIGINAL",person),reasoningApi.act("TASK","ORIGINAL",person),reasoningApi.query("TASK","ACTION",person)]);expect(fetch).toHaveBeenCalledTimes(16);for(const [url,init] of fetch.mock.calls as unknown as [string,RequestInit][]){expect(url.startsWith(`${base}/api/`)).toBe(true);expect(url.includes("/v2/product/v2/product/")).toBe(false);expect(new Headers(init.headers).get("X-Workbench-Demo-Role")).toBe("manager");expect(init.credentials).toBe("same-origin");if(init.body==="ORIGINAL")expect(new Headers(init.headers).get("X-CSRF-Token")).toBe(person.csrf_token);}});
});
it("Inter原许可字体通过CSS相对依赖交构建器，不再访问网关根/fonts",()=>{const css=readFileSync(fileURLToPath(new URL("../app/globals.css",import.meta.url)),"utf8");expect(css).toContain('url("../public/fonts/Inter-Latin.woff2")');expect(css).not.toContain('url("/fonts/');expect(readFileSync(fileURLToPath(new URL("../public/fonts/Inter-Latin.woff2",import.meta.url))).length).toBeGreaterThan(1000);});
