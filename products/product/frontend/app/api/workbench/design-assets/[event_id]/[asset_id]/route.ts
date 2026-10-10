import { readAsset } from "@/lib/partner-design";
import { requirePerson } from "@/lib/auth";
import { failure } from "@/lib/partner-http";
export async function GET(request:Request,context:{params:Promise<{event_id:string;asset_id:string}>}){try{const s=requirePerson(request);const p=await context.params;return await readAsset(s,p.event_id,p.asset_id);}catch(e){return failure(e);}}
