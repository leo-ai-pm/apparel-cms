import {fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {InvitePanel} from "@/app/team/invite-panel";
import {identity} from "./series-fixtures";
const manager={...identity,user:{...identity.user,username:"manager",role:"manager"},context:{...identity.context,subject:"manager"},access:{mode:"normal",role:"manager",synthetic_identity:false}};
afterEach(()=>vi.unstubAllGlobals());
describe("团队访问模式",()=>{
 it("无SSR access时仍按服务器确认冻结注册，不呈现可创建邀请码的假能力",async()=>{const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({...manager,access:{mode:"demo",role:"manager",synthetic_identity:true}})));vi.stubGlobal("fetch",fetch);render(<InvitePanel username="manager"/>);expect(screen.queryByRole("button",{name:"创建一次邀请码"})).not.toBeInTheDocument();expect(await screen.findByText(/登录与注册暂时关闭/)).toBeInTheDocument();expect(screen.getByRole("link",{name:"返回负责人工作台"})).toHaveAttribute("href","/workbench?demo_role=manager");expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][1]).toMatchObject({headers:{"X-Workbench-Demo-Role":"manager"}});});
 it("普通模式保留邀请码，并在点击时重新核对经理context",async()=>{const fetch=vi.fn(async(url:string)=>new Response(JSON.stringify(url==="/api/auth/me"?manager:{code:"a".repeat(32),expiresAt:"2026-10-11T00:00:00Z"})));vi.stubGlobal("fetch",fetch);render(<InvitePanel username="manager"/>);fireEvent.click(await screen.findByRole("button",{name:"创建一次邀请码"}));await waitFor(()=>expect(screen.getByLabelText("一次邀请码")).toHaveValue("a".repeat(32)));expect(fetch).toHaveBeenCalledTimes(3);const calls=fetch.mock.calls as unknown as [string,RequestInit][];expect(calls[2][0]).toBe("/api/team/invites");expect(JSON.parse(String(calls[2][1].body))).toEqual({expected_context:manager.context});expect(new Headers(calls[2][1].headers).get("X-Workbench-Demo-Role")).toBe("manager");});
});
