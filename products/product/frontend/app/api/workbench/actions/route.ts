import { getAction, requirePerson } from "@/lib/partner-workflow";
import { failure, json } from "@/lib/partner-http";
export async function GET(request:Request){try{return json(getAction(requirePerson(request),new URL(request.url).searchParams.get("action_id")??""));}catch(e){return failure(e);}}
