"use client";

import {useEffect,useRef,useState,type ReactNode} from "react";
import {appPath} from "@/lib/app-path";
import {roleHeaders,type Identity} from "@/features/series-workbench/api";

// All private resource reads stay on the personnel API; a plain anchor cannot
// carry the tab's fixed role header. Blob URLs exist only after authorization.
export function PrivateResourceLink({path,identity,download,className,children}:{path:string;identity:Identity|null;download?:string;className?:string;children:ReactNode}){
 const [pending,setPending]=useState(false),[error,setError]=useState(""),controller=useRef<AbortController|null>(null),urls=useRef<string[]>([]);
 useEffect(()=>()=>{controller.current?.abort();controller.current=null;urls.current.forEach(url=>URL.revokeObjectURL(url));urls.current=[];},[identity,path]);
 return <span><button type="button" data-resource-path={path} className={className} disabled={!identity||pending} aria-busy={pending||undefined} onClick={async()=>{
  if(!identity||controller.current)return;
  const control=new AbortController();controller.current=control;setPending(true);setError("");const timer=setTimeout(()=>control.abort(),16000);
  // Open during the user gesture so browsers permit the authorized image tab.
  const target=download?null:window.open("about:blank","_blank");if(target)target.opener=null;
  try{const response=await fetch(appPath(path),{headers:roleHeaders(identity.user.role),credentials:"same-origin",cache:"no-store",signal:control.signal});if(!response.ok)throw new Error(`资源未取得授权或暂不可读取（${response.status}），请重新核对工作台。`);const blob=await response.blob();if(!download&&!["image/png","image/jpeg","image/webp","image/gif","image/avif"].includes(blob.type))throw new Error("结果不是已支持的图片格式，请核对受控资源。");if(control.signal.aborted){target?.close();return;}const url=URL.createObjectURL(blob);urls.current.push(url);
   if(target&&!target.closed)target.location.replace(url);else{const link=document.createElement("a");link.href=url;link.download=download||"design-result";document.body.append(link);link.click();link.remove();}
  }catch(cause){target?.close();if(!control.signal.aborted)setError(cause instanceof Error?cause.message:"资源读取失败，请重试。");else if(controller.current===control)setError("资源读取超时或已停止，请重新核对后重试。");}
  finally{clearTimeout(timer);if(controller.current===control){controller.current=null;setPending(false);}}
 }}>{pending?"正在读取受控资源…":children}</button>{error&&<small role="alert">{error}</small>}</span>;
}
