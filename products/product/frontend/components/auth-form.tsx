"use client";

import { useRef, useState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { appPath } from "@/lib/app-path";

const errors:Record<string,string>={invalid:"账号或密码不正确，请核对后重试。",fields:"请核对账号、姓名和密码格式；两次密码须一致。",invite:"邀请码无效、已使用或过期，请向负责人领取有效邀请码。",username:"这个账号已被使用，请换一个。",setup:"账号服务尚未配置，请联系维护人员。"};
export function AuthForm({mode,configured,hasError}:{mode:"login"|"register";configured:boolean;hasError:boolean}){
 const register=mode==="register",[pending,setPending]=useState(false),[validation,setValidation]=useState(""),busy=useRef(false);
 return <form action={appPath(`/api/auth/${mode}`)} method="post" onSubmit={async(event)=>{
  event.preventDefault();if(busy.current)return;const form=event.currentTarget,values=new FormData(form);
  if(register&&values.get("password")!==values.get("confirm")){setValidation("两次密码不一致，请重新核对。");form.querySelector<HTMLInputElement>("[name=confirm]")?.focus();return;}
  busy.current=true;setPending(true);setValidation("");const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),16000);
  try{const body=new URLSearchParams();for(const [key,value] of values)body.set(key,String(value));const response=await fetch(appPath(`/api/auth/${mode}`),{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/x-www-form-urlencoded","X-Workbench-Demo-Role":new URLSearchParams(window.location.search).get("demo_role")==="manager"?"manager":"staff"},body,signal:controller.signal});
   const url=new URL(response.url||window.location.href);if(response.ok&&url.pathname===appPath("/workbench")){window.location.assign(appPath("/workbench"));return;}
   let message=errors[url.searchParams.get("error")||""];if(!message&&response.headers.get("content-type")?.includes("application/json")){const value:unknown=await response.json();if(value&&typeof value==="object"&&"error" in value){const error=value.error;if(response.status===409&&error&&typeof error==="object"&&"code" in error&&error.code==="LOGIN_FROZEN"){window.location.assign(appPath("/demo/staff"));return;}if(error&&typeof error==="object"&&"message" in error&&typeof error.message==="string")message=error.message.slice(0,500);}}
   setValidation(message||"请求未完成，请核对账号信息或稍后重试。");form.querySelectorAll<HTMLInputElement>("input[type=password]").forEach(input=>{input.value="";});
  }catch{setValidation("连接中断或等待超时。姓名、账号和邀请码仍保留，请核对登录状态后重试。");}finally{clearTimeout(timer);busy.current=false;setPending(false);}
 }}>
 {register&&<><label htmlFor="auth-name">你的姓名</label><input id="auth-name" name="displayName" required minLength={2} maxLength={30} autoComplete="name" placeholder="输入你的姓名"/><label htmlFor="auth-code">负责人提供的一次邀请码</label><input id="auth-code" name="code" required minLength={32} maxLength={32} pattern="[A-Za-z0-9_-]{32}" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="粘贴邀请码，使用后失效"/></>}
 <label htmlFor="auth-username">登录账号</label><input id="auth-username" name="username" required minLength={register?3:undefined} maxLength={32} pattern={register?"[a-z0-9._-]{3,32}":undefined} autoComplete="username" autoCapitalize="none" spellCheck={false} aria-invalid={hasError||undefined} aria-describedby={hasError?"auth-error":undefined} placeholder={register?"英文小写字母、数字、点或横线":"输入你的团队账号"}/>
 <label htmlFor="auth-password">{register?"设置密码":"密码"}</label><input id="auth-password" name="password" type="password" required minLength={register?12:undefined} maxLength={128} autoComplete={register?"new-password":"current-password"} placeholder={register?"至少 12 位":"输入密码"}/>
 {register&&<><label htmlFor="auth-confirm">确认密码</label><input id="auth-confirm" name="confirm" type="password" required minLength={12} maxLength={128} autoComplete="new-password" aria-invalid={Boolean(validation)||undefined} aria-describedby={validation?"auth-validation":undefined} placeholder="再次输入密码"/></>}
 {validation&&<p id="auth-validation" role="alert">{validation}</p>}
 <button type="submit" disabled={!configured||pending} aria-busy={pending||undefined}>{pending?<><LoaderCircle className="spin" size={18} aria-hidden="true"/>{register?"正在注册…":"正在登录…"}</>:<>{register?"注册并进入工作台":"登录工作台"}<ArrowRight size={18} aria-hidden="true"/></>}</button>
 </form>;
}
