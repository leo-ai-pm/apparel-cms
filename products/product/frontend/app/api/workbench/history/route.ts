import { getHistory, requirePerson } from "@/lib/partner-workflow";
import { failure, json } from "@/lib/partner-http";
export async function GET(request:Request){try{const s=requirePerson(request);const q=new URL(request.url).searchParams;return json(getHistory(s,q.get("id")??"",{cursor:q.get("cursor"),limit:q.get("limit"),record_type:q.get("record_type"),record_id:q.get("record_id")}));}catch(e){return failure(e);}}
