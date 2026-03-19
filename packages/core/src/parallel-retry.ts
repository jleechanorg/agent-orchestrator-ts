/**
 * Parallel Retry Monitor (bd-tzt)
 *
 * Spawns multiple sessions in parallel with different strategies,
 * monitors their CI status, and picks the first winner (first-green-wins).
 */

import { randomUUID } from "node:crypto";
import type {
  SessionId,
  CIStatus,
  SessionManager,
  PluginRegistry,
  OrchestratorConfig,
  SCM,
  SessionSpawnConfig,
} from "./types.js";
import { TERMINAL_STATUSES } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RaceGroup {
  id: string;
  parentSessionId: SessionId;
  projectId: string;
  sessions: RaceEntry[];
  status: "running" | "won" | "failed" | "cancelled";
  winner?: SessionId;
  startedAt: Date;
  config: { killOnSuccess: boolean };
}

export interface RaceEntry {
  sessionId: SessionId;
  strategy: string;
  ciStatus: CIStatus;
  lastChecked?: Date;
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

interface ParallelRetryDeps {
  sessionManager: SessionManager;
  registry: PluginRegistry;
  config: OrchestratorConfig;
}

export class ParallelRetryMonitor {
  private readonly races = new Map<string, RaceGroup>();
  private readonly sessionManager: SessionManager;
  private readonly registry: PluginRegistry;
  private readonly config: OrchestratorConfig;

  constructor(deps: ParallelRetryDeps) {
    this.sessionManager = deps.sessionManager;
    this.registry = deps.registry;
    this.config = deps.config;
  }

  /**
   * Start a race: spawn parallel sessions with different strategies.
   */
  async startRace(
    parentSessionId: SessionId,
    projectId: string,
    strategies: string[],
    parallelRetryConfig: {
      maxParallel: number;
      strategies: string[];
      killOnSuccess?: boolean;
    },
  ): Promise<RaceGroup> {
    const raceId = randomUUID();
    const toSpawn = strategies.slice(0, parallelRetryConfig.maxParallel);

    const entries: RaceEntry[] = [];
    for (const strategy of toSpawn) {
      const spawnConfig: SessionSpawnConfig = {
        projectId,
        prompt: strategy,
      };
      const session = await this.sessionManager.spawn(spawnConfig);
      entries.push({
        sessionId: session.id,
        strategy,
        ciStatus: "none",
      });
    }

    const race: RaceGroup = {
      id: raceId,
      parentSessionId,
      projectId,
      sessions: entries,
      status: "running",
      startedAt: new Date(),
      config: { killOnSuccess: parallelRetryConfig.killOnSuccess !== false },
    };

    this.races.set(raceId, race);
    return race;
  }

  /**
   * Check race progress: poll CI status for each session.
   */
  async checkRace(raceId: string): Promise<RaceGroup> {
    const race = this.races.get(raceId);
    if (!race) throw new Error(`Race not found: ${raceId}`);

    const scmName =
      this.config.projects[race.projectId]?.scm?.plugin ?? "github";
    const scm = this.registry.get<SCM>("scm", scmName);

    let allFailedOrTerminal = true;

    for (const entry of race.sessions) {
      const session = await this.sessionManager.get(entry.sessionId);
      if (!session) {
        entry.ciStatus = "failing";
        entry.lastChecked = new Date();
        continue;
      }

      if (session.pr && scm) {
        const ci = await scm.getCISummary(session.pr);
        entry.ciStatus = ci;
        entry.lastChecked = new Date();

        if (ci === "passing") {
          race.status = "won";
          race.winner = entry.sessionId;
          return race;
        }
      }

      const isTerminal = TERMINAL_STATUSES.has(session.status);
      const isFailing = entry.ciStatus === "failing";

      if (!(isTerminal && isFailing) && !(isTerminal && entry.ciStatus === "none")) {
        allFailedOrTerminal = false;
      }
    }

    if (allFailedOrTerminal) {
      race.status = "failed";
    }

    return race;
  }

  /**
   * Resolve a won race: kill losers (unless killOnSuccess is false), return winner.
   */
  async resolveRace(
    raceId: string,
  ): Promise<{ winner: RaceEntry; losers: RaceEntry[] }> {
    const race = this.races.get(raceId);
    if (!race) throw new Error(`Race not found: ${raceId}`);
    if (race.status !== "won") {
      throw new Error(`Race ${raceId} is not won (status: ${race.status})`);
    }

    const winner = race.sessions.find((e) => e.sessionId === race.winner);
    if (!winner) throw new Error(`Winner session not found in race ${raceId}`);

    const losers = race.sessions.filter((e) => e.sessionId !== race.winner);

    if (race.config.killOnSuccess) {
      for (const loser of losers) {
        await this.sessionManager.kill(loser.sessionId);
      }
    }

    return { winner, losers };
  }

  /**
   * Get current race status by ID.
   */
  getRaceStatus(raceId: string): RaceGroup | undefined {
    return this.races.get(raceId);
  }

  /**
   * List all races that are still running.
   */
  listActiveRaces(): RaceGroup[] {
    return [...this.races.values()].filter((r) => r.status === "running");
  }
}
