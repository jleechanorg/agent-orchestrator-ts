"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { isOrchestratorSession } from "@jleechanorg/ao-core/types";
import { SessionDetail } from "@/components/SessionDetail";
import { type DashboardSession, getAttentionLevel, type AttentionLevel } from "@/lib/types";
import { activityIcon } from "@/lib/activity-icons";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";

const SESSION_FETCH_TIMEOUT_MS = 8000;
const SESSION_LOAD_MAX_CONSECUTIVE_FAILURES = 4;
const SESSION_LOAD_MAX_RETRY_ELAPSED_MS = 30_000;
const SESSION_LOAD_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function buildSessionTitle(session: DashboardSession): string {
  const id = session.id;
  const emoji = session.activity ? (activityIcon[session.activity] ?? "") : "";
  const isOrchestrator = isOrchestratorSession(session);

  let detail: string;

  if (isOrchestrator) {
    detail = "Orchestrator Terminal";
  } else if (session.pr) {
    detail = `#${session.pr.number} ${truncate(session.pr.branch, 30)}`;
  } else if (session.branch) {
    detail = truncate(session.branch, 30);
  } else {
    detail = "Session Detail";
  }

  return emoji ? `${emoji} ${id} | ${detail}` : `${id} | ${detail}`;
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.message.toLowerCase().includes("aborted")) return true;
  return false;
}

function isTransientSessionLoadError(error: unknown): boolean {
  if (isAbortLikeError(error)) return true;
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("timed out") ||
      message.includes("network") ||
      message.includes("failed to fetch")
    );
  }
  return false;
}

interface ZoneCounts {
  merge: number;
  respond: number;
  review: number;
  pending: number;
  working: number;
  done: number;
}

export default function SessionPage() {
  const params = useParams();
  const id = params.id as string;

  const [session, setSession] = useState<DashboardSession | null>(null);
  const [zoneCounts, setZoneCounts] = useState<ZoneCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionProjectId = session?.projectId ?? null;
  const sessionIsOrchestrator = session ? isOrchestratorSession(session) : false;

  const fetchingSessionRef = useRef(false);
  const sessionFetchControllerRef = useRef<AbortController | null>(null);
  const hasLoadedSessionRef = useRef(false);
  const sessionLoadFailureCountRef = useRef(0);
  const sessionLoadFirstFailureAtRef = useRef<number | null>(null);
  const sessionLoadRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSessionIdRef = useRef(id);

  const clearSessionLoadRetry = useCallback(() => {
    if (sessionLoadRetryTimerRef.current) {
      clearTimeout(sessionLoadRetryTimerRef.current);
      sessionLoadRetryTimerRef.current = null;
    }
  }, []);

  const resetSessionLoadFailures = useCallback(() => {
    sessionLoadFailureCountRef.current = 0;
    sessionLoadFirstFailureAtRef.current = null;
    clearSessionLoadRetry();
  }, [clearSessionLoadRetry]);

  useEffect(() => {
    if (session) {
      document.title = buildSessionTitle(session);
    } else {
      document.title = `${id} | Session Detail`;
    }
  }, [session, id]);

  const fetchSession = useCallback(async () => {
    if (fetchingSessionRef.current) return;
    fetchingSessionRef.current = true;
    const controller = new AbortController();
    sessionFetchControllerRef.current = controller;
    const fetchId = id;
    let keepLoadingForRetry = false;
    try {
      const data = await fetchJsonWithTimeout<DashboardSession | { error: string }>(
        `/api/sessions/${encodeURIComponent(id)}`,
        { timeoutMs: SESSION_FETCH_TIMEOUT_MS, signal: controller.signal },
      );
      if ("error" in data && typeof data.error === "string" && !("id" in data)) {
        setError(data.error);
        setSession(null);
        setLoading(false);
        resetSessionLoadFailures();
        return;
      }
      if (currentSessionIdRef.current !== fetchId) return;
      setSession(data as DashboardSession);
      setError(null);
      hasLoadedSessionRef.current = true;
      resetSessionLoadFailures();
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to load session";

      if (!hasLoadedSessionRef.current && isTransientSessionLoadError(err)) {
        const failureCount = sessionLoadFailureCountRef.current + 1;
        sessionLoadFailureCountRef.current = failureCount;
        sessionLoadFirstFailureAtRef.current ??= Date.now();
        const elapsedMs = Date.now() - sessionLoadFirstFailureAtRef.current;
        const shouldKeepRetrying =
          failureCount < SESSION_LOAD_MAX_CONSECUTIVE_FAILURES &&
          elapsedMs < SESSION_LOAD_MAX_RETRY_ELAPSED_MS;

        if (shouldKeepRetrying) {
          const delay =
            SESSION_LOAD_RETRY_BACKOFF_MS[
              Math.min(failureCount - 1, SESSION_LOAD_RETRY_BACKOFF_MS.length - 1)
            ];
          keepLoadingForRetry = true;
          setLoading(true);
          console.warn("Session fetch failed transiently; retrying", {
            sessionId: id,
            failureCount,
            retryInMs: delay,
            error: err,
          });
          clearSessionLoadRetry();
          sessionLoadRetryTimerRef.current = setTimeout(() => {
            sessionLoadRetryTimerRef.current = null;
            void fetchSession();
          }, delay);
          return;
        }
      }

      console.error("Failed to fetch session:", err);
      if (!hasLoadedSessionRef.current) {
        setError(message);
      }
    } finally {
      if (!keepLoadingForRetry) {
        setLoading(false);
      }
      fetchingSessionRef.current = false;
      if (sessionFetchControllerRef.current === controller) {
        sessionFetchControllerRef.current = null;
      }
    }
  }, [clearSessionLoadRetry, id, resetSessionLoadFailures]);

  const fetchZoneCounts = useCallback(async () => {
    if (!sessionIsOrchestrator || !sessionProjectId) return;
    try {
      const body = await fetchJsonWithTimeout<{ sessions: DashboardSession[] }>(
        `/api/sessions?project=${encodeURIComponent(sessionProjectId)}`,
        { timeoutMs: 5000 },
      );
      const sessions = body.sessions ?? [];
      const counts: ZoneCounts = {
        merge: 0,
        respond: 0,
        review: 0,
        pending: 0,
        working: 0,
        done: 0,
      };
      for (const s of sessions) {
        if (!isOrchestratorSession(s)) {
          counts[getAttentionLevel(s) as AttentionLevel]++;
        }
      }
      setZoneCounts(counts);
    } catch {
      // non-critical - status strip just won't show
    }
  }, [sessionIsOrchestrator, sessionProjectId]);

  useEffect(() => {
    currentSessionIdRef.current = id;
    sessionFetchControllerRef.current?.abort();
    fetchingSessionRef.current = false;
    resetSessionLoadFailures();
    fetchSession();
    const t = setTimeout(fetchZoneCounts, 2000);
    return () => clearTimeout(t);
  }, [fetchSession, fetchZoneCounts, id, resetSessionLoadFailures]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchSession();
      fetchZoneCounts();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchSession, fetchZoneCounts]);

  useEffect(() => {
    return () => {
      clearSessionLoadRetry();
      sessionFetchControllerRef.current?.abort();
    };
  }, [clearSessionLoadRetry]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-base)]">
        <div className="text-[13px] text-[var(--color-text-tertiary)]">Loading session…</div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg-base)]">
        <div className="text-[13px] text-[var(--color-status-error)]">
          {error ?? "Session not found"}
        </div>
        <a href="/" className="text-[12px] text-[var(--color-accent)] hover:underline">
          ← Back to dashboard
        </a>
      </div>
    );
  }

  return (
    <SessionDetail
      session={session}
      isOrchestrator={sessionIsOrchestrator}
      orchestratorZones={zoneCounts ?? undefined}
    />
  );
}
