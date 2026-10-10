import { requirePerson } from "@/lib/auth";
import { failure,json } from "@/lib/partner-http";
export async function GET(request:Request){try{requirePerson(request);return json({configured:false,provider:null,paid_models:false,tools:{},reason:"CAPABILITY_UNAVAILABLE"});}catch(e){return failure(e);}}
