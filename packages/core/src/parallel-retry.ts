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
  status: "running" | "won" | "failed" | "cancelled" | "resolved";
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
  /** Tracks raceIds currently being checked to serialize concurrent calls. */
  private readonly checking = new Set<string>();

  constructor(deps: ParallelRetryDeps) {
    this.sessionManager = deps.sessionManager;
    this.registry = deps.registry;
    this.config = deps.config;
  }

  /**
   * Start a race: spawn parallel sessions with different strategies.
   *
   * Strategies are sourced exclusively from `parallelRetryConfig.strategies`.
   * If a spawn() call fails, already-spawned sessions are killed (rollback).
   */
  async startRace(
    parentSessionId: SessionId,
    projectId: string,
    issueId: string | undefined,
    parallelRetryConfig: {
      maxParallel: number;
      strategies: string[];
      killOnSuccess?: boolean;
    },
  ): Promise<RaceGroup> {
    const raceId = randomUUID();
    const toSpawn = parallelRetryConfig.strategies.slice(
      0,
      parallelRetryConfig.maxParallel,
    );

    const entries: RaceEntry[] = [];
    const spawnedSessionIds: SessionId[] = [];

    try {
      for (const strategy of toSpawn) {
        const spawnConfig: SessionSpawnConfig = {
          projectId,
          issueId,
          agent: strategy,
        };
        const session = await this.sessionManager.spawn(spawnConfig);
        spawnedSessionIds.push(session.id);
        entries.push({
          sessionId: session.id,
          strategy,
          ciStatus: "none",
        });
      }
    } catch (err: unknown) {
      // Rollback: kill any sessions that were already spawned
      await Promise.allSettled(
        spawnedSessionIds.map((id) => this.sessionManager.kill(id)),
      );
      throw err;
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
   *
   * Serialized per raceId — concurrent calls for the same race return the
   * current snapshot without re-polling. Throws if SCM plugin is missing.
   */
  async checkRace(raceId: string): Promise<RaceGroup> {
    const race = this.races.get(raceId);
    if (!race) throw new Error(`Race not found: ${raceId}`);

    // Guard: already resolved — nothing to poll.
    if (race.status === "won" || race.status === "failed" || race.status === "cancelled" || race.status === "resolved") {
      return race;
    }

    // Serialize: if another tick is already checking this race, return current state.
    if (this.checking.has(raceId)) {
      return race;
    }

    this.checking.add(raceId);
    try {
      const scmName =
        this.config.projects[race.projectId]?.scm?.plugin ?? "github";
      const scm = this.registry.get<SCM>("scm", scmName);

      if (!scm) {
        throw new Error(
          `SCM plugin "${scmName}" not found for project "${race.projectId}"`,
        );
      }

      let allFailedOrTerminal = true;

      for (const entry of race.sessions) {
        const session = await this.sessionManager.get(entry.sessionId);
        if (!session) {
          entry.ciStatus = "failing";
          entry.lastChecked = new Date();
          continue;
        }

        if (session.pr) {
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
        const isNonPassingTerminal =
          isTerminal &&
          (isFailing ||
            entry.ciStatus === "none" ||
            entry.ciStatus === "pending");

        if (!isNonPassingTerminal) {
          allFailedOrTerminal = false;
        }
      }

      if (allFailedOrTerminal) {
        race.status = "failed";
      }

      return race;
    } finally {
      this.checking.delete(raceId);
    }
  }

  /**
   * Resolve a won race: kill losers (unless killOnSuccess is false), return winner.
   *
   * Uses Promise.allSettled for best-effort loser cleanup so one rejection
   * does not prevent killing the remaining losers.
   */
  async resolveRace(raceId: string): Promise<{ winner: RaceEntry; losers: RaceEntry[] }> {
    const race = this.races.get(raceId);
    if (!race) throw new Error(`Race not found: ${raceId}`);
    if (race.status !== "won") {
      throw new Error(`Race ${raceId} is not won (status: ${race.status})`);
    }

    const winner = race.sessions.find((e) => e.sessionId === race.winner);
    if (!winner) throw new Error(`Winner session not found in race ${raceId}`);

    const losers = race.sessions.filter((e) => e.sessionId !== race.winner);

    if (race.config.killOnSuccess) {
      await Promise.allSettled(
        losers.map((loser) => this.sessionManager.kill(loser.sessionId)),
      );
    }

    race.status = "resolved";

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
