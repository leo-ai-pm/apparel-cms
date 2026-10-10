import { listDeliveries } from "@/lib/partner-design";
import { failure,json } from "@/lib/partner-http";
export async function GET(request:Request){try{return json(listDeliveries(request));}catch(e){return failure(e);}}
