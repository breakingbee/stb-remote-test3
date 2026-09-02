import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import AsyncStorage from "@react-native-async-storage/async-storage";

import { ScreenContainer } from "@/components/screen-container";
import { DEFAULT_KEYS, KeyCode, MOCK_DEVICE, MouseClickType, type KeyAction, type StbDevice } from "@/lib/stb-protocol";
import { VinputTransport } from "@/lib/vinput-transport";
import { discoverHiSiliconStbs } from "@/lib/upnp-discovery";
import { resolveVinputEndpoint, startVinput } from "@/lib/vinput-control";
import { accessHello } from "@/lib/access-control";
import { getMirrorCapability, startMirror } from "@/lib/mirror-control";

/** Digit '0'..'9' -> real STB keycode (KeyInfo.KEYCODE_0.._9). '0' is 11, not "7 + digit". */
function digitKeyCode(digit: string): number {
  const n = Number(digit);
  return n === 0 ? KeyCode.DIGIT_0 : KeyCode.DIGIT_1 + (n - 1);
}

const COLORS = {
  background: "#0B1118",
  surface: "#131D28",
  elevated: "#1B2938",
  text: "#F5F8FB",
  muted: "#9AAABD",
  blue: "#5B9BFF",
  blueDeep: "#2D7FF9",
  green: "#48D597",
  border: "#273747",
  red: "#F07A83",
  yellow: "#F0C75E",
};

type ControlProps = {
  label: string;
  symbol?: string;
  onPress: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  tint?: string;
  compact?: boolean;
};

function Control({ label, symbol, onPress, onPressIn, onPressOut, tint, compact }: ControlProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={({ pressed }) => [
        styles.control,
        compact && styles.compactControl,
        pressed && styles.pressed,
      ]}
    >
      {symbol ? <Text style={[styles.controlSymbol, tint ? { color: tint } : null]}>{symbol}</Text> : null}
      <Text style={styles.controlLabel}>{label}</Text>
    </Pressable>
  );
}

function DirectionButton({ label, symbol, onPress }: { label: string; symbol: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.directionButton, pressed && styles.pressed]}
    >
      <Text style={styles.directionSymbol}>{symbol}</Text>
    </Pressable>
  );
}

export default function HomeScreen() {
  const [device, setDevice] = useState<StbDevice>(MOCK_DEVICE);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [lastAction, setLastAction] = useState("Ready");
  const [screenMode, setScreenMode] = useState<"remote" | "trackpad" | "view">("remote");
  const [hostText, setHostText] = useState(MOCK_DEVICE.host);
  const [portText, setPortText] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [channelPadVisible, setChannelPadVisible] = useState(false);
  const [channelText, setChannelText] = useState("");
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem("stb-remote.stb-host"),
      AsyncStorage.getItem("stb-remote.vinput-port"),
    ]).then(([storedHost, storedPort]) => {
      const host = storedHost?.trim() || MOCK_DEVICE.host;
      const port = Number(storedPort);
      setHostText(host);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        setDevice((current) => ({ ...current, host, vinput: { host, port, serviceName: "HI_UPNP_VAR_VinpuServerURI" } }));
      } else {
        setDevice((current) => ({ ...current, host }));
      }
    }).catch(() => undefined);
  }, []);

  const endpointReady = device.vinput?.port ? device.vinput.port > 0 : false;
  const statusLabel = endpointReady ? "Ready to send" : "Discovery preview";
  const endpointHost = device.vinput?.host ?? device.host;
  const endpointPort = device.vinput?.port ?? 0;
  const endpointServiceName = device.vinput?.serviceName;
  const transport = useMemo(
    () => new VinputTransport({ host: endpointHost, port: endpointPort, serviceName: endpointServiceName }),
    [endpointHost, endpointPort, endpointServiceName],
  );

  useEffect(() => () => transport.close(), [transport]);

  const mirrorCapability = useMemo(() => getMirrorCapability(device), [device]);

  // Trackpad: relative-motion mouse (RemoteMouse.java). Drag to move the STB cursor,
  // a short tap sends a left click, and a two-finger-style long hold sends right click.
  const dragMoved = useRef(false);
  const trackpadResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        dragMoved.current = false;
      },
      onPanResponderMove: (_event, gesture) => {
        if (Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2) dragMoved.current = true;
        transport.sendMouseMove(gesture.vx * 24, gesture.vy * 24);
      },
      onPanResponderRelease: () => {
        if (!dragMoved.current) {
          transport.sendMouseClick(MouseClickType.LEFT_SINGLE_CLICK);
          setLastAction("Left click sent");
        } else {
          setLastAction("Cursor moved");
        }
      },
    }),
  ).current;

  const sendKey = (action: KeyAction) => {
    const result = transport.sendTap(action.keyCode);
    if (!endpointReady) {
      setLastAction(`${action.label} · preview packet ready`);
      return;
    }
    setLastAction(result.ok ? `${action.label} · sent over UDP` : `${action.label} · ${result.reason}`);
  };

  const key = useMemo(() => {
    const byLabel = new Map(DEFAULT_KEYS.map((item) => [item.label, item]));
    return (label: string): KeyAction => byLabel.get(label) ?? { label, keyCode: 0, symbol: "" };
  }, []);

  const startRepeat = (action: KeyAction) => {
    sendKey(action);
    repeatTimer.current = setInterval(() => sendKey(action), 180);
  };

  const stopRepeat = () => {
    if (repeatTimer.current) {
      clearInterval(repeatTimer.current);
      repeatTimer.current = null;
    }
  };

  const discover = async () => {
    setDiscovering(true);
    setLastAction("Searching local network…");
    try {
      const devices = await discoverHiSiliconStbs();
      const first = devices.find((item) => item.vinput) ?? devices[0];
      if (!first) {
        setLastAction("No multiscreen STB found");
        Alert.alert("No STB found", "Make sure the iPhone and STB are on the same Wi‑Fi network.");
        return;
      }

      // Resolve the real Vinput endpoint and pairing before committing to it, so the
      // UI never shows "Ready" for a port that turned out to be unreachable.
      const [helloResult, resolvedEndpoint] = await Promise.all([
        accessHello(first),
        resolveVinputEndpoint(first),
      ]);
      if (first.services?.vinput?.controlUrl) {
        await startVinput(first).catch(() => undefined);
      }

      const resolved: StbDevice = { ...first, vinput: resolvedEndpoint };
      setDevice(resolved);
      setHostText(resolved.host);
      await AsyncStorage.setItem("stb-remote.stb-host", resolved.host);
      if (resolved.vinput?.port) await AsyncStorage.setItem("stb-remote.vinput-port", String(resolved.vinput.port));
      setLastAction(helloResult.ok ? `Paired with ${resolved.name}` : `Found ${resolved.name} (unpaired — sending anyway)`);
    } catch {
      setLastAction("Discovery failed");
      Alert.alert("Discovery failed", "The local-network permission may be denied, or the STB may not advertise its multiscreen service.");
    } finally {
      setDiscovering(false);
    }
  };

  const sendChannel = () => {
    if (!channelText) return;
    for (const character of channelText) {
      sendKey({ label: character, keyCode: digitKeyCode(character), symbol: character });
    }
    sendKey({ label: "OK", keyCode: KeyCode.ENTER, symbol: "○" });
    setLastAction(`Channel ${channelText} sent`);
    setChannelText("");
    setChannelPadVisible(false);
  };

  const saveEndpoint = () => {
    const host = hostText.trim();
    const port = Number(portText);
    if (!host) {
      Alert.alert("Invalid address", "Enter the STB IP address or hostname.");
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      Alert.alert("Invalid port", "Enter a Vinput UDP port between 1 and 65535.");
      return;
    }
    setDevice((current) => ({ ...current, host, vinput: { host, port, serviceName: "HI_UPNP_VAR_VinpuServerURI" } }));
    AsyncStorage.setItem("stb-remote.stb-host", host).catch(() => undefined);
    AsyncStorage.setItem("stb-remote.vinput-port", String(port)).catch(() => undefined);
    setPortText("");
    setSettingsVisible(false);
    setLastAction("Vinput endpoint saved");
  };

  return (
    <ScreenContainer edges={["top", "left", "right", "bottom"]} containerClassName="bg-background" className="px-5">
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.eyebrow}>LOCAL CONTROL</Text>
            <Text style={styles.title}>STB Remote</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Open connection settings" onPress={() => setSettingsVisible(true)} style={styles.settingsButton}>
            <Text style={styles.settingsSymbol}>⋯</Text>
          </Pressable>
        </View>

        <View style={styles.connectionCard}>
          <View style={[styles.statusDot, endpointReady ? styles.statusReady : styles.statusIdle]} />
          <View style={styles.connectionText}>
            <Text style={styles.deviceName}>{device.name}</Text>
            <Text style={styles.deviceMeta}>{device.host} · {statusLabel}</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </View>

        <View style={styles.modeSwitch}>
          <Pressable onPress={() => setScreenMode("remote")} style={[styles.modeOption, screenMode === "remote" && styles.modeSelected]}>
            <Text style={[styles.modeText, screenMode === "remote" && styles.modeSelectedText]}>Remote</Text>
          </Pressable>
          <Pressable onPress={() => setScreenMode("trackpad")} style={[styles.modeOption, screenMode === "trackpad" && styles.modeSelected]}>
            <Text style={[styles.modeText, screenMode === "trackpad" && styles.modeSelectedText]}>Trackpad</Text>
          </Pressable>
          <Pressable onPress={() => setScreenMode("view")} style={[styles.modeOption, screenMode === "view" && styles.modeSelected]}>
            <Text style={[styles.modeText, screenMode === "view" && styles.modeSelectedText]}>Screen View</Text>
          </Pressable>
        </View>

        {screenMode === "trackpad" ? (
          <View style={styles.trackpadWrap}>
            <View {...trackpadResponder.panHandlers} style={styles.trackpadSurface}>
              <Text style={styles.trackpadHint}>Drag to move · tap to click</Text>
            </View>
            <View style={styles.trackpadButtons}>
              <Pressable
                onPress={() => {
                  transport.sendMouseClick(MouseClickType.LEFT_SINGLE_CLICK);
                  setLastAction("Left click sent");
                }}
                style={({ pressed }) => [styles.trackpadButton, pressed && styles.pressed]}
              >
                <Text style={styles.trackpadButtonText}>Left click</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  transport.sendMouseClick(MouseClickType.RIGHT_SINGLE_CLICK);
                  setLastAction("Right click sent");
                }}
                style={({ pressed }) => [styles.trackpadButton, pressed && styles.pressed]}
              >
                <Text style={styles.trackpadButtonText}>Right click</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  transport.sendMouseWheel("up");
                  setLastAction("Scroll up sent");
                }}
                style={({ pressed }) => [styles.trackpadButton, pressed && styles.pressed]}
              >
                <Text style={styles.trackpadButtonText}>Scroll ↑</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  transport.sendMouseWheel("down");
                  setLastAction("Scroll down sent");
                }}
                style={({ pressed }) => [styles.trackpadButton, pressed && styles.pressed]}
              >
                <Text style={styles.trackpadButtonText}>Scroll ↓</Text>
              </Pressable>
            </View>
          </View>
        ) : screenMode === "view" ? (
          <View style={styles.viewEmptyState}>
            <Text style={styles.viewIcon}>▣</Text>
            <Text style={styles.viewTitle}>Screen View</Text>
            <Text style={styles.viewBody}>
              {mirrorCapability.controlAvailable
                ? "The mirror session handshake (SetMirrorParameter / StartMirror / StopMirror) is fully implemented and can open a session on the STB."
                : "Discover a device to enable the mirror-session handshake."}
              {"\n\n"}
              {mirrorCapability.reason}
            </Text>
            <Pressable
              onPress={async () => {
                if (!mirrorCapability.controlAvailable) {
                  setLastAction("Discover a device first");
                  return;
                }
                setLastAction("Requesting mirror session…");
                const result = await startMirror(device);
                setLastAction(result.ok ? "Mirror session requested (no video decode)" : "Mirror request failed");
              }}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Request mirror session</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.dpadWrap}>
              <DirectionButton label="Move up" symbol="⌃" onPress={() => sendKey({ label: "Up", keyCode: KeyCode.DPAD_UP, symbol: "⌃" })} />
              <View style={styles.dpadMiddle}>
                <DirectionButton label="Move left" symbol="‹" onPress={() => sendKey({ label: "Left", keyCode: KeyCode.DPAD_LEFT, symbol: "‹" })} />
                <Pressable accessibilityRole="button" accessibilityLabel="Select" onPress={() => sendKey({ label: "OK", keyCode: KeyCode.ENTER, symbol: "○" })} style={({ pressed }) => [styles.okButton, pressed && styles.pressed]}>
                  <Text style={styles.okText}>OK</Text>
                </Pressable>
                <DirectionButton label="Move right" symbol="›" onPress={() => sendKey({ label: "Right", keyCode: KeyCode.DPAD_RIGHT, symbol: "›" })} />
              </View>
              <DirectionButton label="Move down" symbol="⌄" onPress={() => sendKey({ label: "Down", keyCode: KeyCode.DPAD_DOWN, symbol: "⌄" })} />
            </View>

            <View style={styles.utilityRow}>
              <Control label="Back" symbol="‹" onPress={() => sendKey({ label: "Back", keyCode: KeyCode.BACK, symbol: "‹" })} />
              <Control label="Home" symbol="⌂" onPress={() => sendKey({ label: "Home", keyCode: KeyCode.HOME, symbol: "⌂" })} />
              <Control label="Info" symbol="ⓘ" onPress={() => sendKey(key("Info"))} tint={COLORS.blue} />
              <Control label="Guide" symbol="▤" onPress={() => sendKey(key("Guide"))} />
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Open numeric channel keypad" onPress={() => setChannelPadVisible(true)} style={({ pressed }) => [styles.keypadButton, pressed && styles.pressed]}>
              <Text style={styles.keypadIcon}>⌨</Text>
              <Text style={styles.keypadText}>Enter channel number</Text>
            </Pressable>

            <View style={styles.sideControls}>
              <View style={styles.sideGroup}>
                <Text style={styles.groupLabel}>VOLUME</Text>
                <Control label="Volume up" symbol="+" onPressIn={() => startRepeat(key("Volume +"))} onPressOut={stopRepeat} onPress={() => sendKey(key("Volume +"))} compact />
                <Control label="Mute" symbol="⌁" onPress={() => sendKey(key("Mute"))} compact />
                <Control label="Volume down" symbol="−" onPressIn={() => startRepeat(key("Volume −"))} onPressOut={stopRepeat} onPress={() => sendKey(key("Volume −"))} compact />
              </View>
              <View style={styles.sideGroup}>
                <Text style={styles.groupLabel}>CHANNEL</Text>
                <Control label="Channel up" symbol="+" onPressIn={() => startRepeat(key("Channel +"))} onPressOut={stopRepeat} onPress={() => sendKey(key("Channel +"))} compact />
                <Control label="Channel down" symbol="−" onPressIn={() => startRepeat(key("Channel −"))} onPressOut={stopRepeat} onPress={() => sendKey(key("Channel −"))} compact />
              </View>
            </View>

            <Text style={styles.sectionLabel}>MEDIA & COLOUR</Text>
            <View style={styles.mediaRow}>
              <Control label="Play" symbol="▶" onPress={() => sendKey({ label: "Play", keyCode: KeyCode.PLAY, symbol: "▶" })} compact />
              <Control label="Stop" symbol="■" onPress={() => sendKey({ label: "Stop", keyCode: KeyCode.STOP, symbol: "■" })} compact />
              <Control label="Previous" symbol="⏮" onPress={() => sendKey({ label: "Previous", keyCode: KeyCode.PREVIOUS, symbol: "⏮" })} compact />
              <Control label="Next" symbol="⏭" onPress={() => sendKey({ label: "Next", keyCode: KeyCode.NEXT, symbol: "⏭" })} compact />
            </View>
            <View style={styles.colorRow}>
              {[{ label: "Red", keyCode: KeyCode.RED, color: COLORS.red }, { label: "Green", keyCode: KeyCode.GREEN, color: COLORS.green }, { label: "Yellow", keyCode: KeyCode.YELLOW, color: COLORS.yellow }, { label: "Blue", keyCode: KeyCode.BLUE, color: COLORS.blue }].map((item) => (
                <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={item.label} onPress={() => sendKey({ ...item, symbol: "●" })} style={({ pressed }) => [styles.colorButton, { borderColor: item.color }, pressed && styles.pressed]}>
                  <Text style={[styles.colorDot, { color: item.color }]}>●</Text>
                  <Text style={styles.colorLabel}>{item.label}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        <View style={styles.statusBar}>
          <View style={styles.statusBarDot} />
          <Text style={styles.statusBarText}>{lastAction}</Text>
          <Text style={styles.packetHint}>{endpointReady ? `${device.vinput?.port} / UDP` : "Protocol preview"}</Text>
        </View>
      </ScrollView>

      <Modal visible={channelPadVisible} animationType="slide" transparent onRequestClose={() => setChannelPadVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Channel number</Text>
            <Text style={styles.channelDisplay}>{channelText || "—"}</Text>
            <View style={styles.numberGrid}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((digit) => (
                <Pressable key={digit} accessibilityRole="button" accessibilityLabel={`Digit ${digit}`} onPress={() => setChannelText((current) => `${current}${digit}`.slice(0, 4))} style={({ pressed }) => [styles.numberButton, pressed && styles.pressed]}>
                  <Text style={styles.numberText}>{digit}</Text>
                </Pressable>
              ))}
              <Pressable accessibilityRole="button" accessibilityLabel="Delete last digit" onPress={() => setChannelText((current) => current.slice(0, -1))} style={({ pressed }) => [styles.numberButton, pressed && styles.pressed]}>
                <Text style={styles.numberText}>⌫</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Clear channel number" onPress={() => setChannelText("")} style={({ pressed }) => [styles.numberButton, pressed && styles.pressed]}>
                <Text style={styles.numberText}>C</Text>
              </Pressable>
            </View>
            <Pressable disabled={!channelText} onPress={sendChannel} style={[styles.primaryButton, !channelText && styles.disabledButton]}>
              <Text style={styles.primaryButtonText}>Send channel</Text>
            </Pressable>
            <Pressable onPress={() => setChannelPadVisible(false)} style={styles.cancelButton}><Text style={styles.cancelText}>Close</Text></Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={settingsVisible} animationType="slide" transparent onRequestClose={() => setSettingsVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Connection</Text>
            <Text style={styles.sheetSubtitle}>The reference remote discovers this endpoint through UPnP Vinput service metadata.</Text>
            <Pressable onPress={discover} disabled={discovering} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{discovering ? "Searching…" : "Discover STB on Wi‑Fi"}</Text>
            </Pressable>
            <Text style={styles.inputLabel}>STB address</Text>
            <TextInput value={hostText} onChangeText={setHostText} autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" placeholder="192.168.1.11" placeholderTextColor={COLORS.muted} style={styles.input} />
            <Text style={styles.inputLabel}>Vinput UDP port</Text>
            <TextInput value={portText} onChangeText={setPortText} keyboardType="number-pad" placeholder={device.vinput?.port ? String(device.vinput.port) : "Discovered automatically"} placeholderTextColor={COLORS.muted} style={styles.input} />
            <Pressable onPress={saveEndpoint} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Save endpoint</Text>
            </Pressable>
            <Pressable onPress={() => setSettingsVisible(false)} style={styles.cancelButton}>
              <Text style={styles.cancelText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 12, paddingBottom: 28 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 18 },
  eyebrow: { color: COLORS.blue, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  title: { color: COLORS.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.8, marginTop: 3 },
  settingsButton: { width: 44, height: 44, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  settingsSymbol: { color: COLORS.text, fontSize: 24, marginTop: -9, letterSpacing: 2 },
  connectionCard: { flexDirection: "row", alignItems: "center", backgroundColor: COLORS.surface, borderRadius: 18, borderWidth: 1, borderColor: COLORS.border, padding: 16, marginBottom: 14 },
  statusDot: { width: 11, height: 11, borderRadius: 6, marginRight: 12 },
  statusReady: { backgroundColor: COLORS.green },
  statusIdle: { backgroundColor: COLORS.yellow },
  connectionText: { flex: 1 },
  deviceName: { color: COLORS.text, fontSize: 16, fontWeight: "700" },
  deviceMeta: { color: COLORS.muted, fontSize: 12, marginTop: 3 },
  chevron: { color: COLORS.muted, fontSize: 28, fontWeight: "300" },
  modeSwitch: { flexDirection: "row", padding: 4, borderRadius: 14, backgroundColor: COLORS.surface, marginBottom: 16 },
  modeOption: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: 11 },
  modeSelected: { backgroundColor: COLORS.elevated },
  modeText: { color: COLORS.muted, fontSize: 14, fontWeight: "700" },
  modeSelectedText: { color: COLORS.text },
  dpadWrap: { alignItems: "center", paddingVertical: 8, backgroundColor: COLORS.surface, borderRadius: 26, borderWidth: 1, borderColor: COLORS.border },
  dpadMiddle: { flexDirection: "row", alignItems: "center", gap: 18, marginVertical: 8 },
  directionButton: { width: 58, height: 52, alignItems: "center", justifyContent: "center", borderRadius: 17, backgroundColor: COLORS.elevated },
  directionSymbol: { color: COLORS.text, fontSize: 30, lineHeight: 32 },
  okButton: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center", backgroundColor: COLORS.blueDeep, shadowColor: COLORS.blue, shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 7 }, elevation: 6 },
  okText: { color: "#FFFFFF", fontSize: 17, fontWeight: "800", letterSpacing: 0.5 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
  utilityRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  control: { flex: 1, minHeight: 68, alignItems: "center", justifyContent: "center", borderRadius: 17, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 6 },
  compactControl: { minHeight: 56 },
  controlSymbol: { color: COLORS.text, fontSize: 23, lineHeight: 25, fontWeight: "600" },
  controlLabel: { color: COLORS.muted, fontSize: 10, fontWeight: "700", marginTop: 5, textAlign: "center" },
  sideControls: { flexDirection: "row", gap: 12, marginTop: 16 },
  sideGroup: { flex: 1, gap: 8 },
  groupLabel: { color: COLORS.muted, fontSize: 10, fontWeight: "800", letterSpacing: 1.3, marginBottom: 1 },
  sectionLabel: { color: COLORS.muted, fontSize: 10, fontWeight: "800", letterSpacing: 1.3, marginTop: 20, marginBottom: 8 },
  mediaRow: { flexDirection: "row", gap: 8 },
  colorRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  colorButton: { flex: 1, minHeight: 58, alignItems: "center", justifyContent: "center", borderRadius: 16, backgroundColor: COLORS.surface, borderWidth: 1 },
  colorDot: { fontSize: 20, lineHeight: 20 },
  colorLabel: { color: COLORS.muted, fontSize: 10, fontWeight: "700", marginTop: 4 },
  keypadButton: { flexDirection: "row", minHeight: 52, alignItems: "center", justifyContent: "center", gap: 9, backgroundColor: COLORS.elevated, borderRadius: 15, borderWidth: 1, borderColor: COLORS.border, marginTop: 12 },
  keypadIcon: { color: COLORS.blue, fontSize: 20 },
  keypadText: { color: COLORS.text, fontSize: 13, fontWeight: "800" },
  channelDisplay: { color: COLORS.text, fontSize: 42, fontWeight: "800", textAlign: "center", paddingVertical: 16, letterSpacing: 4 },
  numberGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  numberButton: { width: "31.5%", minHeight: 52, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: COLORS.elevated, borderWidth: 1, borderColor: COLORS.border },
  numberText: { color: COLORS.text, fontSize: 20, fontWeight: "700" },
  disabledButton: { opacity: 0.4 },
  statusBar: { flexDirection: "row", alignItems: "center", marginTop: 18, paddingHorizontal: 4 },
  statusBarDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.green, marginRight: 8 },
  statusBarText: { color: COLORS.muted, fontSize: 11, flex: 1 },
  packetHint: { color: COLORS.muted, fontSize: 10, fontWeight: "700" },
  trackpadWrap: { gap: 12 },
  trackpadSurface: { minHeight: 320, borderRadius: 24, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, alignItems: "center", justifyContent: "center" },
  trackpadHint: { color: COLORS.muted, fontSize: 13, fontWeight: "600" },
  trackpadButtons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  trackpadButton: { flexGrow: 1, minWidth: "47%", minHeight: 52, alignItems: "center", justifyContent: "center", borderRadius: 15, backgroundColor: COLORS.elevated, borderWidth: 1, borderColor: COLORS.border },
  trackpadButtonText: { color: COLORS.text, fontSize: 13, fontWeight: "700" },
  viewEmptyState: { alignItems: "center", justifyContent: "center", minHeight: 420, padding: 28, borderRadius: 24, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  viewIcon: { color: COLORS.blue, fontSize: 42, marginBottom: 16 },
  viewTitle: { color: COLORS.text, fontSize: 22, fontWeight: "800" },
  viewBody: { color: COLORS.muted, fontSize: 14, lineHeight: 21, textAlign: "center", marginTop: 10, marginBottom: 24 },
  primaryButton: { backgroundColor: COLORS.blueDeep, minHeight: 52, borderRadius: 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 22, marginTop: 12 },
  primaryButtonText: { color: "#FFFFFF", fontWeight: "800", fontSize: 14 },
  secondaryButton: { backgroundColor: COLORS.elevated, minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", paddingHorizontal: 18, marginBottom: 4, borderWidth: 1, borderColor: COLORS.border },
  secondaryButtonText: { color: COLORS.blue, fontWeight: "800", fontSize: 13 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: { backgroundColor: COLORS.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 34, borderWidth: 1, borderColor: COLORS.border },
  sheetHandle: { alignSelf: "center", width: 42, height: 5, borderRadius: 3, backgroundColor: COLORS.border, marginBottom: 18 },
  sheetTitle: { color: COLORS.text, fontSize: 24, fontWeight: "800" },
  sheetSubtitle: { color: COLORS.muted, fontSize: 13, lineHeight: 19, marginTop: 6, marginBottom: 18 },
  inputLabel: { color: COLORS.muted, fontSize: 11, fontWeight: "800", letterSpacing: 1, marginTop: 12, marginBottom: 7 },
  input: { color: COLORS.text, backgroundColor: COLORS.elevated, borderRadius: 13, borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15 },
  cancelButton: { alignItems: "center", paddingVertical: 16 },
  cancelText: { color: COLORS.muted, fontSize: 14, fontWeight: "700" },
});
