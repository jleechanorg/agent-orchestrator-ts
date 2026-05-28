/**
 * Plugin load order — ensures dependencies load before dependents.
 *
 * Topological sort of BUILTIN_PLUGINS so that when a plugin declares
 * dependencies, they are loaded first. Companion module to avoid
 * modifying upstream plugin-registry.ts.
 */

import type { PluginSlot } from "./types.js";

export interface PluginDependency {
  slot: PluginSlot;
  name: string;
}

export interface LoadOrderEntry {
  slot: PluginSlot;
  name: string;
  pkg: string;
  dependsOn?: PluginDependency[];
}

const SLOT_ORDER: PluginSlot[] = [
  "runtime",
  "workspace",
  "scm",
  "tracker",
  "agent",
  "notifier",
  "terminal",
  "lock",
  "poller",
];

function slotPriority(slot: PluginSlot): number {
  const index = SLOT_ORDER.indexOf(slot);
  return index >= 0 ? index : SLOT_ORDER.length;
}

export function computeLoadOrder(entries: LoadOrderEntry[]): LoadOrderEntry[] {
  const byKey = new Map<string, LoadOrderEntry>();
  for (const entry of entries) {
    byKey.set(`${entry.slot}:${entry.name}`, entry);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: LoadOrderEntry[] = [];

  function visit(key: string): void {
    if (visited.has(key)) return;
    if (visiting.has(key)) return;

    visiting.add(key);
    const entry = byKey.get(key);
    if (entry?.dependsOn) {
      for (const dep of entry.dependsOn) {
        const depKey = `${dep.slot}:${dep.name}`;
        visit(depKey);
      }
    }
    visiting.delete(key);
    visited.add(key);
    if (entry) {
      result.push(entry);
    }
  }

  const sorted = [...entries].sort(
    (a, b) => slotPriority(a.slot) - slotPriority(b.slot),
  );

  for (const entry of sorted) {
    visit(`${entry.slot}:${entry.name}`);
  }

  return result;
}
