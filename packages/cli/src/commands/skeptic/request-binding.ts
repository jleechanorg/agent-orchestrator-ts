import { fetchIssueComments } from "./gh-client.js";
import { escapeRegexLiteral } from "./verdict-utils.js";

export type SkepticTriggerType = "gate" | "cron";

export async function findTriggerRequestId(
  owner: string,
  repo: string,
  prNumber: number,
  triggerSha?: string,
  triggerType?: SkepticTriggerType,
  workflowActor = "github-actions[bot]",
): Promise<string | undefined> {
  const normalizedSha = triggerSha?.trim();
  const validSha = normalizedSha && /^[0-9a-f]{7,40}$/i.test(normalizedSha) ? normalizedSha : undefined;
  if (!validSha) return undefined;

  const comments = await fetchIssueComments(owner, repo, prNumber);
  const escapedSha = escapeRegexLiteral(validSha);
  const requestIdRe = /<!--\s*skeptic-request-id-([A-Za-z0-9_.:-]+)\s*-->/i;
  const headShaRe = new RegExp(`<!--\\s*skeptic-head-sha-${escapedSha}\\s*-->`, "i");
  const triggerTypes: SkepticTriggerType[] = triggerType ? [triggerType] : ["gate", "cron"];
  const requestIdsByType = new Map<SkepticTriggerType, Set<string>>();
  const normalizedWorkflowActor = workflowActor.toLowerCase();

  for (const comment of comments) {
    if (comment.user?.login?.toLowerCase() !== normalizedWorkflowActor) continue;
    if (!headShaRe.test(comment.body)) continue;
    for (const type of triggerTypes) {
      const triggerLabel = new RegExp(`SKEPTIC_${type.toUpperCase()}_TRIGGER`, "i");
      const triggerMarker = new RegExp(`<!--\\s*skeptic-${type}-trigger-${escapedSha}\\s*-->`, "i");
      if (!triggerLabel.test(comment.body) || !triggerMarker.test(comment.body)) continue;
      const match = comment.body.match(requestIdRe);
      if (!match?.[1]) continue;
      const idsForType = requestIdsByType.get(type) ?? new Set<string>();
      idsForType.add(match[1]);
      requestIdsByType.set(type, idsForType);
    }
  }

  if (triggerType) {
    const idsForType = requestIdsByType.get(triggerType);
    if (!idsForType || idsForType.size !== 1) return undefined;
    return [...idsForType][0];
  }

  for (const idsForType of requestIdsByType.values()) {
    if (idsForType.size !== 1) return undefined;
  }
  const requestIds = new Set([...requestIdsByType.values()].flatMap((idsForType) => [...idsForType]));
  if (requestIds.size !== 1) return undefined;
  return [...requestIds][0];
}
