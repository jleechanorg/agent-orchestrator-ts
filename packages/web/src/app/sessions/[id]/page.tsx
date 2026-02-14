"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { SessionDetail } from "@/components/SessionDetail";
import type { DashboardSession } from "@/lib/types";

export default function SessionPage() {
  const params = useParams();
  const id = params.id as string;

  const [session, setSession] = useState<DashboardSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch session data (memoized to avoid recreating on every render)
  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        setError("Session not found");
        setLoading(false);
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json() as DashboardSession;
      setSession(data);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch session:", err);
      setError("Failed to load session");
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Initial fetch
  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  // Poll for updates every 5 seconds
  useEffect(() => {
    const interval = setInterval(fetchSession, 5000);
    return () => clearInterval(interval);
  }, [fetchSession]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-[var(--color-text-muted)]">Loading session...</div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-[var(--color-accent-red)]">
          {error || "Session not found"}
        </div>
      </div>
    );
  }

  return <SessionDetail session={session} />;
}
