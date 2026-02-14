import { notFound } from "next/navigation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { SessionDetail } from "@/components/SessionDetail";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function SessionPage({ params }: Props) {
  const { id } = await params;

  const { sessionManager } = await getServices().catch(() => {
    notFound();
    // notFound() throws, so this never runs, but TS needs the return type
    return null as never;
  });

  const coreSession = await sessionManager.get(id);
  if (!coreSession) {
    notFound();
  }

  return <SessionDetail session={sessionToDashboard(coreSession)} />;
}
