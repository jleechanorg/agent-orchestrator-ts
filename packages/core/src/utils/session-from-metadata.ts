import { VALID_PR_STATES, type PRState, type RuntimeHandle, type Session, type SessionId, type SessionStatus, type ActivitySignal, type CanonicalSessionLifecycle } from "../types.js";
import { parsePrFromUrl } from "./pr.js";
import { safeJsonParse, validateStatus } from "./validation.js";
import { parseCanonicalLifecycle } from "../lifecycle-state.js";
import { createActivitySignal } from "../activity-signal.js";

interface SessionFromMetadataOptions {
  projectId?: string;
  status?: SessionStatus;
  activity?: Session["activity"];
  runtimeHandle?: RuntimeHandle | null;
  createdAt?: Date;
  lastActivityAt?: Date;
  restoredAt?: Date;
  sessionPrefix?: string;
}

export function sessionFromMetadata(
  sessionId: SessionId,
  meta: Record<string, string>,
  options: SessionFromMetadataOptions = {},
): Session {
  const status = options.status ?? validateStatus(meta["status"]);
  const lifecycle: CanonicalSessionLifecycle = parseCanonicalLifecycle(meta, {
    sessionId,
    status,
    sessionKind: meta["role"] === "orchestrator" || sessionId.endsWith("-orchestrator")
      ? "orchestrator"
      : "worker",
  });
  const activitySignal: ActivitySignal = createActivitySignal("unavailable");
  return {
    id: sessionId,
    tmuxName: meta["tmuxName"] ?? undefined,
    projectId: meta["project"] ?? options.projectId ?? "",
    status,
    activity: options.activity ?? null,
    activitySignal,
    lifecycle,
    branch: meta["branch"] || null,
    issueId: meta["issue"] || null,
    pr: meta["pr"]
      ? (() => {
          const parsed = parsePrFromUrl(meta["pr"]);
          const rawPrState = meta["prState"] as string | undefined;
          const prState: PRState | undefined =
            rawPrState !== undefined && VALID_PR_STATES.has(rawPrState as PRState)
              ? (rawPrState as PRState)
              : undefined;
          return {
            number: parsed?.number ?? 0,
            url: meta["pr"],
            title: "",
            owner: parsed?.owner ?? "",
            repo: parsed?.repo ?? "",
            branch: meta["branch"] ?? "",
            baseBranch: "",
            isDraft: false,
            ...(prState ? { state: prState } : {}),
          };
        })()
      : null,
    workspacePath: meta["worktree"] || null,
    runtimeHandle:
      options.runtimeHandle !== undefined
        ? options.runtimeHandle
        : meta["runtimeHandle"]
          ? safeJsonParse<RuntimeHandle>(meta["runtimeHandle"])
          : null,
    agentInfo: meta["summary"] ? { summary: meta["summary"], agentSessionId: null } : null,
    createdAt: meta["createdAt"] ? new Date(meta["createdAt"]) : (options.createdAt ?? new Date()),
    lastActivityAt: options.lastActivityAt ?? new Date(),
    restoredAt:
      options.restoredAt ?? (meta["restoredAt"] ? new Date(meta["restoredAt"]) : undefined),
    metadata: meta,
  };
}
