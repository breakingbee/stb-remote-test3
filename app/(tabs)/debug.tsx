import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { clearDiscoveryLogs, getDiscoveryLogs, subscribeDiscoveryLogs, type DiscoveryLogEntry } from "@/lib/upnp-discovery";

const colors = {
  bg: "#0D0F12",
  panel: "#171A1F",
  border: "#292E36",
  text: "#F5F7FA",
  muted: "#AAB2BD",
  green: "#78B916",
  yellow: "#E4BF5B",
  red: "#E56B6F",
};

function levelColor(level: DiscoveryLogEntry["level"]) {
  if (level === "ok") return colors.green;
  if (level === "warn") return colors.yellow;
  if (level === "error") return colors.red;
  return colors.muted;
}

export default function DebugScreen() {
  const [logs, setLogs] = useState<DiscoveryLogEntry[]>(getDiscoveryLogs());

  useEffect(() => subscribeDiscoveryLogs(setLogs), []);

  return (
    <ScreenContainer edges={["top", "left", "right", "bottom"]} containerClassName="bg-background">
      <View style={styles.header}>
        <View>
          <Text style={styles.kicker}>STB REMOTE</Text>
          <Text style={styles.title}>Discovery Log</Text>
          <Text style={styles.subtitle}>Live view of what the iPhone is actually doing on startup.</Text>
        </View>
        <Pressable onPress={clearDiscoveryLogs} style={styles.clearButton}>
          <Text style={styles.clearText}>CLEAR</Text>
        </Pressable>
      </View>

      <View style={styles.summary}>
        <Text style={styles.summaryText}>{logs.length} events recorded</Text>
        <Text style={styles.summaryText}>Open Home to start another scan.</Text>
      </View>

      <ScrollView style={styles.logPanel} contentContainerStyle={styles.logContent} showsVerticalScrollIndicator>
        {logs.length === 0 ? (
          <Text style={styles.empty}>No discovery events yet.</Text>
        ) : logs.map((entry, index) => (
          <View key={`${entry.time}-${index}`} style={styles.row}>
            <Text style={styles.time}>{entry.time}</Text>
            <Text style={[styles.level, { color: levelColor(entry.level) }]}>{entry.level.toUpperCase()}</Text>
            <Text style={styles.message}>{entry.message}</Text>
          </View>
        ))}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingHorizontal: 18, paddingTop: 16, paddingBottom: 14 },
  kicker: { color: colors.green, fontSize: 10, fontWeight: "800", letterSpacing: 1.6 },
  title: { color: colors.text, fontSize: 28, fontWeight: "800", marginTop: 3 },
  subtitle: { color: colors.muted, fontSize: 12, marginTop: 5, maxWidth: 280, lineHeight: 17 },
  clearButton: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10 },
  clearText: { color: colors.text, fontSize: 11, fontWeight: "800" },
  summary: { marginHorizontal: 18, marginBottom: 10, padding: 12, borderRadius: 12, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  summaryText: { color: colors.muted, fontSize: 11, marginVertical: 2 },
  logPanel: { marginHorizontal: 18, marginBottom: 18, backgroundColor: colors.panel, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  logContent: { padding: 12 },
  row: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  time: { color: "#7F8895", fontSize: 10, fontVariant: ["tabular-nums"] },
  level: { fontSize: 9, fontWeight: "800", marginTop: 2 },
  message: { color: colors.text, fontSize: 12, lineHeight: 17, marginTop: 2 },
  empty: { color: colors.muted, fontSize: 13, padding: 10 },
});
