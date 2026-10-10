import { listWorkbench, requirePerson } from "@/lib/partner-workflow";
import { failure, json } from "@/lib/partner-http";
export async function GET(request:Request){try{return json(await listWorkbench(requirePerson(request),new URL(request.url).searchParams.get("cursor")));}catch(e){return failure(e);}}
