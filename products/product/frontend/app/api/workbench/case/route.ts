import { getDetail, mutate, requirePerson } from "@/lib/partner-workflow";
import { body, failure, json } from "@/lib/partner-http";
export async function GET(request:Request){try{return json(await getDetail(requirePerson(request),new URL(request.url).searchParams.get("id")??""));}catch(e){return failure(e);}}
export async function PATCH(request:Request){try{return json(await mutate(requirePerson(request,true),await body(request)));}catch(e){return failure(e);}}
