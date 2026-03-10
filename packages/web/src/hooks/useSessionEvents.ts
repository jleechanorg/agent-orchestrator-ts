"use client";

import { useEffect, useReducer, useRef } from "react";
import type { DashboardSession, SSESnapshotEvent, GlobalPauseState } from "@/lib/types";

interface State {
  sessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
}

type Action =
  | { type: "reset"; sessions: DashboardSession[]; globalPause: GlobalPauseState | null }
  | { type: "snapshot"; patches: SSESnapshotEvent["sessions"] };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "reset":
      return { sessions: action.sessions, globalPause: action.globalPause };
    case "snapshot": {
      const patchMap = new Map(action.patches.map((p) => [p.id, p]));
      let changed = false;
      const next = state.sessions.map((s) => {
        const patch = patchMap.get(s.id);
        if (!patch) return s;
        if (
          s.status === patch.status &&
          s.activity === patch.activity &&
          s.lastActivityAt === patch.lastActivityAt
        ) {
          return s;
        }
        changed = true;
        return {
          ...s,
          status: patch.status,
          activity: patch.activity,
          lastActivityAt: patch.lastActivityAt,
        };
      });
      return changed ? { ...state, sessions: next } : state;
    }
  }
}

interface UseSessionEventsReturn {
  sessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
}

export function useSessionEvents(
  initialSessions: DashboardSession[],
  initialGlobalPause: GlobalPauseState | null,
): UseSessionEventsReturn {
  const [state, dispatch] = useReducer(reducer, {
    sessions: initialSessions,
    globalPause: initialGlobalPause,
  });
  const sessionsRef = useRef(state.sessions);
  const refreshingRef = useRef(false);

  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  useEffect(() => {
    dispatch({ type: "reset", sessions: initialSessions, globalPause: initialGlobalPause });
  }, [initialSessions, initialGlobalPause]);

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string };
        if (data.type === "snapshot") {
          const snapshot = data as SSESnapshotEvent;
          const workerPatches = snapshot.sessions.filter((s) => !s.id.endsWith("-orchestrator"));
          dispatch({ type: "snapshot", patches: workerPatches });

          const currentIds = new Set(sessionsRef.current.map((s) => s.id));
          const snapshotIds = new Set(workerPatches.map((s) => s.id));
          const sameMembership =
            currentIds.size === snapshotIds.size &&
            [...snapshotIds].every((id) => currentIds.has(id));

          if (!sameMembership && !refreshingRef.current) {
            refreshingRef.current = true;
            void fetch("/api/sessions")
              .then((res) => (res.ok ? res.json() : null))
              .then(
                (
                  payload: { sessions?: DashboardSession[]; globalPause?: GlobalPauseState } | null,
                ) => {
                  if (payload?.sessions) {
                    dispatch({
                      type: "reset",
                      sessions: payload.sessions,
                      globalPause: payload.globalPause ?? null,
                    });
                  }
                },
              )
              .finally(() => {
                refreshingRef.current = false;
              });
          }
        }
      } catch {
        // Ignore malformed messages
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here
    };

    return () => {
      es.close();
    };
  }, []);

  return { sessions: state.sessions, globalPause: state.globalPause };
}
