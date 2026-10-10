import {randomBytes,scryptSync} from "node:crypto";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {authenticate,createSession,hashPassword,readSession} from "@/lib/auth";
import {createStaffInvite,registerStaff,registerStaffSelf} from "@/lib/users-db";
const directories:string[]=[];
const scope="legacy-auth-test-updated";
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function configure(){
 const directory=mkdtempSync(path.join(tmpdir(),"product-client-auth-"));directories.push(directory);
 const config=path.join(directory,"config.json");writeFileSync(config,JSON.stringify({instance_id:"client-auth-test",authorized_scope:scope,origin:"http://client-auth.localhost:3091"}),{mode:0o600});
 const hash=(password:string)=>{const salt=randomBytes(16).toString("hex");return `${salt}:${scryptSync(password,salt,64).toString("hex")}`;};
 vi.stubEnv("WORKBENCH_CONFIG_FILE",config);vi.stubEnv("WORKBENCH_USERS_DB",path.join(directory,"users.sqlite"));
 vi.stubEnv("WORKBENCH_SESSION_SECRET",randomBytes(32).toString("hex"));vi.stubEnv("WORKBENCH_STAFF_USERNAME","product");vi.stubEnv("WORKBENCH_STAFF_PASSWORD_HASH",hash("staff-password"));vi.stubEnv("WORKBENCH_MANAGER_USERNAME","manager");vi.stubEnv("WORKBENCH_MANAGER_PASSWORD_HASH",hash("manager-password"));
}
describe("local workbench login under delivered personnel contract",()=>{
 it("uses separate scoped accounts and rejects incorrect passwords",()=>{configure();expect(authenticate("product","staff-password")).toEqual({username:"product",role:"staff",scope});expect(authenticate("manager","manager-password")).toEqual({username:"manager",role:"manager",scope});expect(authenticate("product","manager-password")).toBeNull();});
 it("rejects a tampered or expired persistent session",()=>{configure();const valid=createSession({username:"manager",role:"manager"});expect(readSession(valid)).toEqual({username:"manager",role:"manager",scope});expect(readSession(`${valid}x`)).toBeNull();vi.setSystemTime(Date.now()+9*60*60*1000);expect(readSession(valid)).toBeNull();});
 it("registers once per invite and rejects reserved manager names",()=>{configure();const first=createStaffInvite("manager");expect(registerStaff("xiaolin","小林",hashPassword("safe-password-123"),first.code,["product","manager"])).toBe("ok");expect(authenticate("xiaolin","safe-password-123")).toEqual({username:"xiaolin",role:"staff",scope});expect(readSession(createSession({username:"xiaolin",role:"staff"}))).toEqual({username:"xiaolin",role:"staff",scope});expect(registerStaff("xiaozhou","小周",hashPassword("safe-password-456"),first.code,["product","manager"])).toBe("invite");const second=createStaffInvite("manager");expect(registerStaff("manager","负责人",hashPassword("safe-password-789"),second.code,["product","manager"])).toBe("username");expect(registerStaff("xiaolin","小林",hashPassword("safe-password-789"),second.code,["product","manager"])).toBe("username");expect(registerStaff("xiaozhou","小周",hashPassword("safe-password-456"),second.code,["product","manager"])).toBe("ok");});
 it("refuses self-registration without an invitation under v1.0.1",()=>{configure();expect(registerStaffSelf("zhouzhou","小周",hashPassword("my-private-password"),["product","manager"])).toBe("invite");expect(authenticate("zhouzhou","my-private-password")).toBeNull();});
 it("fails closed without the new instance configuration",()=>{configure();vi.stubEnv("WORKBENCH_CONFIG_FILE","");expect(()=>authenticate("manager","manager-password")).toThrow("人员身份配置不可用");expect(readSession("not-a-real-session")).toBeNull();});
});
