import { redirect } from "next/navigation";
export default async function Page({searchParams}:{searchParams:Promise<{demo_role?:string|string[]}>}){const {demo_role}=await searchParams;redirect(demo_role===undefined?"/workbench":`/workbench?demo_role=${encodeURIComponent(String(demo_role))}`);}
