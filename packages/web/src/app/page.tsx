import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession } from "@/lib/types";
import { getServices } from "@/lib/services";
import { sessionToDashboard, computeStats } from "@/lib/serialize";

export default async function Home() {
  let sessions: DashboardSession[] = [];
  try {
    const { sessionManager } = await getServices();
    const coreSessions = await sessionManager.list();
    sessions = coreSessions.map(sessionToDashboard);
  } catch {
    // Config not found or services unavailable — show empty dashboard
  }

  return <Dashboard sessions={sessions} stats={computeStats(sessions)} />;
}
