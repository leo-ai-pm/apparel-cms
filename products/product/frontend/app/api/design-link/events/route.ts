import { authorizeService } from "@/lib/handoff-auth";
import { queryEvent,receiveEvent } from "@/lib/partner-design";
import { body,failure,json } from "@/lib/partner-http";
export async function GET(request:Request){try{return json(queryEvent(request).receipt);}catch(e){return failure(e);}}
export async function POST(request:Request){try{authorizeService(request,"design_event_writer");const result=await receiveEvent(request,await body(request,3*1024*1024));return json(result.body.receipt,result.status);}catch(e){return failure(e);}}
