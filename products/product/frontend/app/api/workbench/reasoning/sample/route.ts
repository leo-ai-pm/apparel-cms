import { requirePerson, recheckPerson } from "@/lib/auth";
import { ensure } from "@/lib/reasoning-rules";
import { REASONING_CONTRACT } from "@/lib/reasoning-types";
import { SAMPLE_BASE64, SAMPLE_DIGEST } from "@/lib/reasoning-sample";
import { reasoningJson, reasoningFailure } from "@/lib/reasoning-http";
export function GET(request: Request) { try { const person = requirePerson(request); recheckPerson(person); ensure(person.user.role === "manager", "FORBIDDEN", 403, "仅产品负责人可载入合成测试资料"); return reasoningJson({ contract_version: REASONING_CONTRACT, input_base64: SAMPLE_BASE64, input_digest: SAMPLE_DIGEST, label: "12条人工合成反馈，仅用于规则辅助研判演示" }); } catch (error) { return reasoningFailure(error); } }
