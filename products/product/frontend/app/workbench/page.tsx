import { LiveWorkbench } from "../../features/workbench-live/live-workbench";
import { readPagePerson, demoRole, demoAccessEnabled } from "@/lib/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getRegisteredUser } from "@/lib/users-db";

export default async function WorkbenchPage({ searchParams }: { searchParams: Promise<{ demo_role?: string }> }) {
  const role = demoRole((await searchParams).demo_role), person = readPagePerson(await cookies(), role);
  if (!person) redirect(demoAccessEnabled() ? `/demo/${role}` : "/login");
  const user = person.user;
  const displayName = user.role === "staff" ? getRegisteredUser(user.username)?.display_name || user.username : "产品负责人";
  const props = { role: user.role, username: user.username, displayName, access: person.access };
  return <LiveWorkbench {...props} />;
}
