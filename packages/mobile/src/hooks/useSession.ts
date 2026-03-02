import { useState, useEffect, useRef, useCallback } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useBackend } from "../context/BackendContext";
import type { DashboardSession } from "../types";

const POLL_INTERVAL = 5_000;

interface UseSessionResult {
  session: DashboardSession | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSession(id: string): UseSessionResult {
  const { fetchSession } = useBackend();
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Generation counter — incremented on cleanup to invalidate in-flight fetches
  // from a previous effect run (e.g. when backend URL changes).
  const fetchGenRef = useRef(0);

  const doFetch = useCallback(async () => {
    const gen = fetchGenRef.current;
    try {
      const data = await fetchSession(id);
      if (gen !== fetchGenRef.current) return;
      setSession(data);
      setError(null);
    } catch (err) {
      if (gen !== fetchGenRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load session");
    } finally {
      if (gen === fetchGenRef.current) setLoading(false);
    }
  }, [fetchSession, id]);

  const startPolling = useCallback(() => {
    doFetch();
    intervalRef.current = setInterval(doFetch, POLL_INTERVAL);
  }, [doFetch]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    startPolling();

    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === "active") {
        stopPolling();
        startPolling();
      } else {
        stopPolling();
      }
    };

    const sub = AppState.addEventListener("change", handleAppState);

    return () => {
      fetchGenRef.current++; // Invalidate in-flight fetches from this effect run
      stopPolling();
      sub.remove();
    };
  }, [startPolling, stopPolling]);

  const refresh = useCallback(() => {
    setLoading(true);
    doFetch();
  }, [doFetch]);

  return { session, loading, error, refresh };
}
