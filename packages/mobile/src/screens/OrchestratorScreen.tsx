import React from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../navigation/RootNavigator";
import { useSessions } from "../hooks/useSessions";
import { getAttentionLevel, isTerminal, type DashboardSession } from "../types";

type Props = NativeStackScreenProps<RootStackParamList, "Orchestrator">;

const CLI_COMMANDS = [
  { cmd: "ao start [project]", desc: "Start orchestrator + dashboard" },
  { cmd: "ao stop [project]", desc: "Stop orchestrator + dashboard" },
  { cmd: "ao spawn <project> [issue]", desc: "Spawn a session for an issue" },
  { cmd: "ao batch-spawn <project> <issues...>", desc: "Spawn multiple sessions" },
  { cmd: "ao session ls [-p <project>]", desc: "List all active sessions" },
  { cmd: "ao session kill <session>", desc: "Kill a session" },
  { cmd: "ao session restore <session>", desc: "Restore a crashed session" },
  { cmd: "ao session cleanup [-p <project>]", desc: "Clean up merged/closed sessions" },
  { cmd: "ao send <session> [message]", desc: "Send message to a session" },
  { cmd: "ao status [-p <project>]", desc: "Show sessions with PR/CI status" },
  { cmd: "ao review-check [project]", desc: "Check PRs and trigger agents" },
  { cmd: "ao dashboard [-p <port>]", desc: "Start the web dashboard" },
  { cmd: "ao open [target]", desc: "Open session(s) in terminal" },
  { cmd: "ao init [project]", desc: "Initialize config file" },
];

function getZoneCounts(sessions: DashboardSession[]) {
  const counts = { merge: 0, respond: 0, review: 0, pending: 0, working: 0, done: 0 };
  for (const s of sessions) {
    const level = getAttentionLevel(s);
    counts[level]++;
  }
  return counts;
}

export default function OrchestratorScreen({ navigation }: Props) {
  const { sessions, stats, orchestratorId, loading, error, refresh } = useSessions();

  const zones = getZoneCounts(sessions);
  const activeSessions = sessions.filter((s) => !isTerminal(s));

  if (loading && sessions.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#58a6ff" size="large" />
      </View>
    );
  }

  if (error && sessions.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={refresh}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Orchestrator Status */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Orchestrator</Text>
        {orchestratorId ? (
          <TouchableOpacity
            style={styles.orchestratorCard}
            onPress={() => navigation.navigate("SessionDetail", { sessionId: orchestratorId })}
          >
            <View style={styles.orchestratorRow}>
              <View style={[styles.dot, { backgroundColor: "#3fb950" }]} />
              <Text style={styles.orchestratorText}>Running</Text>
            </View>
            <Text style={styles.orchestratorId}>{orchestratorId}</Text>
            <Text style={styles.orchestratorHint}>Tap to view terminal</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.orchestratorCard}>
            <View style={styles.orchestratorRow}>
              <View style={[styles.dot, { backgroundColor: "#8b949e" }]} />
              <Text style={[styles.orchestratorText, { color: "#8b949e" }]}>Not running</Text>
            </View>
            <Text style={styles.orchestratorHint}>Start with: ao start &lt;project&gt;</Text>
          </View>
        )}
      </View>

      {/* Zone Overview */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Session Zones</Text>
        <View style={styles.zonesGrid}>
          <ZoneBadge label="Merge" count={zones.merge} color="#3fb950" />
          <ZoneBadge label="Respond" count={zones.respond} color="#f85149" />
          <ZoneBadge label="Review" count={zones.review} color="#d29922" />
          <ZoneBadge label="Pending" count={zones.pending} color="#e3b341" />
          <ZoneBadge label="Working" count={zones.working} color="#58a6ff" />
          <ZoneBadge label="Done" count={zones.done} color="#8b949e" />
        </View>
      </View>

      {/* Stats */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Overview</Text>
        <StatRow label="Total sessions" value={String(stats?.totalSessions ?? sessions.length)} />
        <StatRow label="Active sessions" value={String(activeSessions.length)} />
        <StatRow label="Open PRs" value={String(stats?.openPRs ?? 0)} />
        <StatRow label="Needs review" value={String(stats?.needsReview ?? 0)} />
      </View>

      {/* CLI Reference */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>CLI Commands</Text>
        <Text style={styles.hint}>Quick reference for managing sessions from terminal.</Text>
        {CLI_COMMANDS.map((c, i) => (
          <View key={i} style={styles.cmdRow}>
            <Text style={styles.cmdText}>{c.cmd}</Text>
            <Text style={styles.cmdDesc}>{c.desc}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function ZoneBadge({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <View style={styles.zoneBadge}>
      <Text style={[styles.zoneCount, { color }]}>{count}</Text>
      <Text style={styles.zoneLabel}>{label}</Text>
    </View>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0d1117",
  },
  content: {
    padding: 14,
    paddingBottom: 32,
    gap: 12,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#0d1117",
  },
  section: {
    backgroundColor: "#161b22",
    borderRadius: 10,
    padding: 16,
  },
  sectionTitle: {
    color: "#8b949e",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 12,
  },
  hint: {
    color: "#8b949e",
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  // Orchestrator card
  orchestratorCard: {
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 8,
    padding: 14,
  },
  orchestratorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  orchestratorText: {
    color: "#3fb950",
    fontSize: 15,
    fontWeight: "600",
  },
  orchestratorId: {
    color: "#8b949e",
    fontSize: 12,
    fontFamily: "monospace",
    marginBottom: 4,
  },
  orchestratorHint: {
    color: "#6e7681",
    fontSize: 12,
  },
  // Zones grid
  zonesGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  zoneBadge: {
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: "center",
    minWidth: 90,
    flex: 1,
  },
  zoneCount: {
    fontSize: 22,
    fontWeight: "700",
  },
  zoneLabel: {
    color: "#8b949e",
    fontSize: 11,
    fontWeight: "600",
    marginTop: 2,
  },
  // Stats
  statRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  statLabel: {
    color: "#8b949e",
    fontSize: 13,
  },
  statValue: {
    color: "#e6edf3",
    fontSize: 13,
    fontWeight: "600",
  },
  // CLI commands
  cmdRow: {
    backgroundColor: "#0d1117",
    borderRadius: 6,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  cmdText: {
    color: "#58a6ff",
    fontSize: 12,
    fontFamily: "monospace",
    marginBottom: 4,
  },
  cmdDesc: {
    color: "#8b949e",
    fontSize: 12,
  },
  // Error
  errorText: {
    color: "#f85149",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: "#21262d",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  retryText: {
    color: "#e6edf3",
    fontSize: 14,
  },
});
