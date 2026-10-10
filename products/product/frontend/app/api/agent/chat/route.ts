import { requirePerson } from "@/lib/auth";
import { WorkbenchError } from "@/lib/partner-workflow";
import { failure } from "@/lib/partner-http";
export async function POST(request:Request){try{requirePerson(request,true);throw new WorkbenchError("CAPABILITY_UNAVAILABLE","本轮模型调用关闭",503);}catch(e){return failure(e);}}
