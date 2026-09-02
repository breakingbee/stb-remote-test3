import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { accessHello, getOrCreateRemoteId } from "@/lib/access-control";
import { getMirrorCapability, startMirror } from "@/lib/mirror-control";
import { discoverHiSiliconStbs } from "@/lib/upnp-discovery";
import { resolveVinputEndpoint, startVinput } from "@/lib/vinput-control";
import { DEFAULT_KEYS, KeyCode, MouseClickType, type KeyAction, type StbDevice } from "@/lib/stb-protocol";
import { VinputTransport } from "@/lib/vinput-transport";

const C = {
  bg: "#121212",
  panel: "#202020",
  panel2: "#2A2A2A",
  key: "#343434",
  keyPressed: "#548E08",
  green: "#78B916",
  greenDark: "#4F8507",
  text: "#FFFFFF",
  muted: "#B7B7B7",
  black: "#090909",
  red: "#E02020",
  orange: "#D98200",
  blue: "#1D79C3",
};

function digitKeyCode(digit: string) {
  const n = Number(digit);
  return n === 0 ? KeyCode.DIGIT_0 : KeyCode.DIGIT_1 + n - 1;
}

function KeyButton({ label, onPress, onPressIn, onPressOut, wide = false, green = false }: {
  label: string;
  onPress: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  wide?: boolean;
  green?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={({ pressed }) => [styles.keyButton, wide && styles.keyButtonWide, green && styles.keyButtonGreen, pressed && styles.keyButtonPressed]}
    >
      <Text style={styles.keyText}>{label}</Text>
    </Pressable>
  );
}

function ArrowButton({ label, symbol, onPress }: { label: string; symbol: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.arrowButton, pressed && styles.keyButtonPressed]}
    >
      <Text style={styles.arrowText}>{symbol}</Text>
    </Pressable>
  );
}

export default function HomeScreen() {
  const [device, setDevice] = useState<StbDevice | null>(null);
  const [scanPhase, setScanPhase] = useState("Starting local network scan…");
  const [discovering, setDiscovering] = useState(false);
  const [lastAction, setLastAction] = useState("Not connected");
  const [mode, setMode] = useState<"remote" | "trackpad" | "view">("remote");
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [channelVisible, setChannelVisible] = useState(false);
  const [channelText, setChannelText] = useState("");
  const [hostText, setHostText] = useState("");
  const [portText, setPortText] = useState("");
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const endpointHost = device?.vinput?.host ?? device?.host ?? "";
  const endpointPort = device?.vinput?.port ?? 0;
  const transport = useMemo(() => new VinputTransport({ host: endpointHost, port: endpointPort, serviceName: device?.vinput?.serviceName }), [endpointHost, endpointPort, device?.vinput?.serviceName]);
  useEffect(() => () => transport.close(), [transport]);

  const connectFoundDevice = useCallback(async (found: StbDevice) => {
    setScanPhase("Connecting to STB…");
    const hello = await accessHello(found);
    if (!hello.ok) throw new Error(`AccessHello failed: ${hello.error ?? "unknown"}`);

    setScanPhase("Starting remote control…");
    const endpoint = await resolveVinputEndpoint(found);
    await startVinput(found);

    const connected = { ...found, vinput: endpoint };
    setDevice(connected);
    setHostText(connected.host);
    await AsyncStorage.setItem("stb-remote.stb-host", connected.host);
    await AsyncStorage.setItem("stb-remote.vinput-port", String(endpoint.port));
    setLastAction(`Connected to ${connected.name}`);
  }, []);

  const discover = useCallback(async () => {
    if (discovering) return;
    setDiscovering(true);
    setDevice(null);
    try {
      setScanPhase("Searching for HiMultiScreen devices…");
      const devices = await discoverHiSiliconStbs();
      if (!devices.length) throw new Error("No HiSilicon STB found on this Wi‑Fi network.");
      setScanPhase(`Found ${devices[0].name || "HiSilicon STB"}. Establishing session…`);
      await connectFoundDevice(devices[0]);
    } catch (error) {
      setLastAction("Discovery failed");
      setScanPhase(error instanceof Error ? error.message : "Discovery failed");
    } finally {
      setDiscovering(false);
    }
  }, [connectFoundDevice, discovering]);

  useEffect(() => {
    getOrCreateRemoteId().catch(() => undefined);
    discover();
  }, [discover]);

  const sendKey = (action: KeyAction) => {
    const result = transport.sendTap(action.keyCode);
    setLastAction(result.ok ? `${action.label} sent` : `${action.label}: ${result.reason}`);
  };

  const key = useCallback((label: string): KeyAction => {
    return new Map(DEFAULT_KEYS.map((item) => [item.label, item])).get(label) ?? { label, keyCode: 0, symbol: label };
  }, []);

  const startRepeat = (action: KeyAction) => {
    sendKey(action);
    repeatTimer.current = setInterval(() => sendKey(action), 160);
  };
  const stopRepeat = () => {
    if (repeatTimer.current) {
      clearInterval(repeatTimer.current);
      repeatTimer.current = null;
    }
  };

  const dragMoved = useRef(false);
  const trackpadResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { dragMoved.current = false; },
    onPanResponderMove: (_event, gesture) => {
      if (Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2) dragMoved.current = true;
      transport.sendMouseMove(gesture.vx * 24, gesture.vy * 24);
    },
    onPanResponderRelease: () => {
      if (!dragMoved.current) transport.sendMouseClick(MouseClickType.LEFT_SINGLE_CLICK);
    },
  })).current;

  const sendChannel = () => {
    for (const digit of channelText) sendKey({ label: digit, keyCode: digitKeyCode(digit), symbol: digit });
    if (channelText) sendKey({ label: "OK", keyCode: KeyCode.ENTER, symbol: "OK" });
    setLastAction(`Channel ${channelText} sent`);
    setChannelText("");
    setChannelVisible(false);
  };

  const saveManual = async () => {
    const host = hostText.trim();
    const port = Number(portText || device?.vinput?.port || 8822);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      Alert.alert("Invalid endpoint", "Enter a valid STB IP address and Vinput port.");
      return;
    }
    try {
      const candidate: StbDevice = { id: `${host}-manual`, name: "HiSilicon STB", host, vinput: { host, port } };
      await connectFoundDevice(candidate);
      setSettingsVisible(false);
    } catch (error) {
      Alert.alert("Connection failed", error instanceof Error ? error.message : "Unable to connect.");
    }
  };

  if (!device) {
    return (
      <ScreenContainer edges={["top", "left", "right", "bottom"]} containerClassName="bg-background">
        <View style={styles.discoveryScreen}>
          <View style={styles.discoveryLogo}>
            <View style={styles.logoInner}><Text style={styles.logoCross}>◆</Text></View>
          </View>
          <Text style={styles.discoveryTitle}>STB Remote</Text>
          <Text style={styles.discoverySubtitle}>HiControl compatible remote</Text>

          <View style={styles.scannerCard}>
            <ActivityIndicator size="large" color={C.green} />
            <Text style={styles.scannerTitle}>{discovering ? "Scanning your network" : "STB not found"}</Text>
            <Text style={styles.scannerPhase}>{scanPhase}</Text>
            <View style={styles.scanLine}><View style={[styles.scanProgress, !discovering && { width: "100%" }]} /></View>
            <Text style={styles.scannerHint}>The remote connects only after the STB is discovered and the control session is started.</Text>
          </View>

          {!discovering ? (
            <>
              <Pressable onPress={discover} style={({ pressed }) => [styles.primaryGreen, pressed && styles.keyButtonPressed]}>
                <Text style={styles.primaryGreenText}>SCAN AGAIN</Text>
              </Pressable>
              <Pressable onPress={() => setSettingsVisible(true)} style={styles.secondaryDark}>
                <Text style={styles.secondaryDarkText}>ENTER STB IP MANUALLY</Text>
              </Pressable>
            </>
          ) : null}

          <Modal visible={settingsVisible} transparent animationType="slide" onRequestClose={() => setSettingsVisible(false)}>
            <View style={styles.modalBackdrop}>
              <View style={styles.sheet}>
                <Text style={styles.sheetTitle}>Connect manually</Text>
                <Text style={styles.sheetLabel}>STB IP address</Text>
                <TextInput value={hostText} onChangeText={setHostText} placeholder="192.168.1.11" placeholderTextColor={C.muted} style={styles.input} keyboardType="numbers-and-punctuation" />
                <Text style={styles.sheetLabel}>Vinput UDP port</Text>
                <TextInput value={portText} onChangeText={setPortText} placeholder="8822" placeholderTextColor={C.muted} style={styles.input} keyboardType="number-pad" />
                <Pressable onPress={saveManual} style={styles.primaryGreen}><Text style={styles.primaryGreenText}>CONNECT</Text></Pressable>
                <Pressable onPress={() => setSettingsVisible(false)}><Text style={styles.cancelText}>CANCEL</Text></Pressable>
              </View>
            </View>
          </Modal>
        </View>
      </ScreenContainer>
    );
  }

  const mirrorCapability = getMirrorCapability(device);

  return (
    <ScreenContainer edges={["top", "left", "right", "bottom"]} containerClassName="bg-background">
      <ScrollView contentContainerStyle={styles.remoteScreen} showsVerticalScrollIndicator={false}>
        <View style={styles.topBar}>
          <View style={styles.deviceBadge}>
            <View style={styles.deviceDot} />
            <View>
              <Text style={styles.deviceName}>{device.name}</Text>
              <Text style={styles.deviceIp}>{device.host}</Text>
            </View>
          </View>
          <Pressable onPress={() => setSettingsVisible(true)} style={styles.gear}><Text style={styles.gearText}>⚙</Text></Pressable>
        </View>

        <View style={styles.modeRow}>
          {(["remote", "trackpad", "view"] as const).map((item) => (
            <Pressable key={item} onPress={() => setMode(item)} style={[styles.modeTab, mode === item && styles.modeTabActive]}>
              <Text style={[styles.modeTabText, mode === item && styles.modeTabTextActive]}>{item === "remote" ? "REMOTE" : item === "trackpad" ? "MOUSE" : "SCREEN"}</Text>
            </Pressable>
          ))}
        </View>

        {mode === "trackpad" ? (
          <View style={styles.trackpadWrap}>
            <View {...trackpadResponder.panHandlers} style={styles.trackpadSurface}>
              <Text style={styles.trackpadIcon}>✋</Text>
              <Text style={styles.trackpadText}>DRAG TO MOVE</Text>
              <Text style={styles.trackpadSub}>Tap to click</Text>
            </View>
            <View style={styles.twoCol}><KeyButton label="LEFT CLICK" onPress={() => transport.sendMouseClick(MouseClickType.LEFT_SINGLE_CLICK)} /><KeyButton label="RIGHT CLICK" onPress={() => transport.sendMouseClick(MouseClickType.RIGHT_SINGLE_CLICK)} /></View>
          </View>
        ) : mode === "view" ? (
          <View style={styles.screenCard}>
            <Text style={styles.screenIcon}>▣</Text>
            <Text style={styles.screenTitle}>SCREEN VIEW</Text>
            <Text style={styles.screenBody}>{mirrorCapability.controlAvailable ? "Mirror control is available. Video decoding will be connected to the native H.264 receiver next." : mirrorCapability.reason}</Text>
            <Pressable onPress={async () => {
              if (!mirrorCapability.controlAvailable) return;
              setLastAction("Starting mirror session…");
              const result = await startMirror(device);
              setLastAction(result.ok ? "Mirror session started" : "Mirror session failed");
            }} style={styles.primaryGreen}><Text style={styles.primaryGreenText}>START SCREEN VIEW</Text></Pressable>
          </View>
        ) : (
          <>
            <View style={styles.functionRow}>
              <KeyButton label="POWER" green onPress={() => sendKey({ label: "Power", keyCode: KeyCode.POWER, symbol: "⏻" })} />
              <KeyButton label="HOME" onPress={() => sendKey({ label: "Home", keyCode: KeyCode.HOME, symbol: "⌂" })} />
              <KeyButton label="BACK" onPress={() => sendKey({ label: "Back", keyCode: KeyCode.BACK, symbol: "↩" })} />
              <KeyButton label="MENU" onPress={() => sendKey(key("Guide"))} />
            </View>

            <View style={styles.dpadPanel}>
              <ArrowButton label="Up" symbol="▲" onPress={() => sendKey({ label: "Up", keyCode: KeyCode.DPAD_UP, symbol: "▲" })} />
              <View style={styles.dpadMiddle}>
                <ArrowButton label="Left" symbol="◀" onPress={() => sendKey({ label: "Left", keyCode: KeyCode.DPAD_LEFT, symbol: "◀" })} />
                <Pressable onPress={() => sendKey({ label: "OK", keyCode: KeyCode.ENTER, symbol: "OK" })} style={({ pressed }) => [styles.okButton, pressed && styles.keyButtonPressed]}><Text style={styles.okText}>OK</Text></Pressable>
                <ArrowButton label="Right" symbol="▶" onPress={() => sendKey({ label: "Right", keyCode: KeyCode.DPAD_RIGHT, symbol: "▶" })} />
              </View>
              <ArrowButton label="Down" symbol="▼" onPress={() => sendKey({ label: "Down", keyCode: KeyCode.DPAD_DOWN, symbol: "▼" })} />
            </View>

            <View style={styles.avRow}>
              <View style={styles.levelBlock}>
                <Text style={styles.levelTitle}>VOLUME</Text>
                <View style={styles.levelRow}>
                  <KeyButton label="−" wide onPressIn={() => startRepeat(key("Volume −"))} onPressOut={stopRepeat} onPress={() => sendKey(key("Volume −"))} />
                  <KeyButton label="MUTE" onPress={() => sendKey(key("Mute"))} />
                  <KeyButton label="+" wide onPressIn={() => startRepeat(key("Volume +"))} onPressOut={stopRepeat} onPress={() => sendKey(key("Volume +"))} />
                </View>
              </View>
              <View style={styles.levelBlock}>
                <Text style={styles.levelTitle}>CHANNEL</Text>
                <View style={styles.levelRow}>
                  <KeyButton label="−" wide onPressIn={() => startRepeat(key("Channel −"))} onPressOut={stopRepeat} onPress={() => sendKey(key("Channel −"))} />
                  <KeyButton label="+" wide onPressIn={() => startRepeat(key("Channel +"))} onPressOut={stopRepeat} onPress={() => sendKey(key("Channel +"))} />
                </View>
              </View>
            </View>

            <View style={styles.numericHeader}><Text style={styles.sectionTitle}>NUMBER PAD</Text><Pressable onPress={() => setChannelVisible(true)}><Text style={styles.linkText}>ENTER CHANNEL</Text></Pressable></View>
            <View style={styles.numericGrid}>
              {["1","2","3","4","5","6","7","8","9","0"].map((digit) => <KeyButton key={digit} label={digit} onPress={() => sendKey({ label: digit, keyCode: digitKeyCode(digit), symbol: digit })} />)}
              <KeyButton label="INFO" onPress={() => sendKey(key("Info"))} />
              <KeyButton label="GUIDE" onPress={() => sendKey(key("Guide"))} />
            </View>

            <View style={styles.mediaRow}>
              <KeyButton label="PREV" onPress={() => sendKey({ label: "Previous", keyCode: KeyCode.PREVIOUS, symbol: "⏮" })} />
              <KeyButton label="PLAY" green onPress={() => sendKey({ label: "Play", keyCode: KeyCode.PLAY, symbol: "▶" })} />
              <KeyButton label="STOP" onPress={() => sendKey({ label: "Stop", keyCode: KeyCode.STOP, symbol: "■" })} />
              <KeyButton label="NEXT" onPress={() => sendKey({ label: "Next", keyCode: KeyCode.NEXT, symbol: "⏭" })} />
            </View>

            <View style={styles.colorRow}>
              <KeyButton label="RED" onPress={() => sendKey({ label: "Red", keyCode: KeyCode.RED, symbol: "●" })} />
              <KeyButton label="GREEN" green onPress={() => sendKey({ label: "Green", keyCode: KeyCode.GREEN, symbol: "●" })} />
              <KeyButton label="YELLOW" onPress={() => sendKey({ label: "Yellow", keyCode: KeyCode.YELLOW, symbol: "●" })} />
              <KeyButton label="BLUE" onPress={() => sendKey({ label: "Blue", keyCode: KeyCode.BLUE, symbol: "●" })} />
            </View>
          </>
        )}

        <View style={styles.statusBar}>
          <View style={styles.deviceDot} />
          <Text style={styles.statusText}>{lastAction}</Text>
          <Text style={styles.statusPort}>{device.vinput?.port}/UDP</Text>
        </View>
      </ScrollView>

      <Modal visible={channelVisible} transparent animationType="slide" onRequestClose={() => setChannelVisible(false)}>
        <View style={styles.modalBackdrop}><View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Enter channel</Text>
          <Text style={styles.channelBig}>{channelText || "—"}</Text>
          <View style={styles.numericGrid}>{["1","2","3","4","5","6","7","8","9","0"].map((d) => <KeyButton key={d} label={d} onPress={() => setChannelText((v) => `${v}${d}`.slice(0,4))} />)}</View>
          <Pressable onPress={sendChannel} style={styles.primaryGreen}><Text style={styles.primaryGreenText}>SEND</Text></Pressable>
          <Pressable onPress={() => setChannelVisible(false)}><Text style={styles.cancelText}>CANCEL</Text></Pressable>
        </View></View>
      </Modal>

      <Modal visible={settingsVisible} transparent animationType="slide" onRequestClose={() => setSettingsVisible(false)}>
        <View style={styles.modalBackdrop}><View style={styles.sheet}>
          <Text style={styles.sheetTitle}>STB CONNECTION</Text>
          <Text style={styles.connectedLine}>CONNECTED · {device.host}</Text>
          <Pressable onPress={() => { setSettingsVisible(false); discover(); }} style={styles.secondaryDark}><Text style={styles.secondaryDarkText}>SCAN AGAIN</Text></Pressable>
          <Text style={styles.sheetLabel}>STB IP address</Text>
          <TextInput value={hostText} onChangeText={setHostText} style={styles.input} placeholder="192.168.1.11" placeholderTextColor={C.muted} keyboardType="numbers-and-punctuation" />
          <Text style={styles.sheetLabel}>Vinput UDP port</Text>
          <TextInput value={portText} onChangeText={setPortText} style={styles.input} placeholder={String(device.vinput?.port ?? 8822)} placeholderTextColor={C.muted} keyboardType="number-pad" />
          <Pressable onPress={saveManual} style={styles.primaryGreen}><Text style={styles.primaryGreenText}>RECONNECT</Text></Pressable>
          <Pressable onPress={() => setSettingsVisible(false)}><Text style={styles.cancelText}>CANCEL</Text></Pressable>
        </View></View>
      </Modal>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  discoveryScreen: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 22, justifyContent: "center" },
  discoveryLogo: { alignSelf: "center", width: 82, height: 82, borderRadius: 28, backgroundColor: C.green, alignItems: "center", justifyContent: "center", marginBottom: 18 },
  logoInner: { width: 62, height: 62, borderRadius: 20, backgroundColor: C.black, alignItems: "center", justifyContent: "center" },
  logoCross: { color: C.green, fontSize: 34 },
  discoveryTitle: { color: C.text, fontSize: 30, fontWeight: "800", textAlign: "center" },
  discoverySubtitle: { color: C.muted, textAlign: "center", marginTop: 4, marginBottom: 28, fontSize: 14 },
  scannerCard: { backgroundColor: C.panel, borderRadius: 18, padding: 24, alignItems: "center", borderWidth: 1, borderColor: "#383838", marginBottom: 18 },
  scannerTitle: { color: C.text, fontSize: 18, fontWeight: "800", marginTop: 15 },
  scannerPhase: { color: C.muted, textAlign: "center", marginTop: 8, lineHeight: 20 },
  scanLine: { width: "100%", height: 5, borderRadius: 3, backgroundColor: C.key, marginTop: 18, overflow: "hidden" },
  scanProgress: { height: "100%", width: "65%", backgroundColor: C.green },
  scannerHint: { color: "#8B8B8B", textAlign: "center", fontSize: 11, marginTop: 14, lineHeight: 16 },
  primaryGreen: { minHeight: 50, borderRadius: 10, backgroundColor: C.green, alignItems: "center", justifyContent: "center", paddingHorizontal: 18, marginTop: 10 },
  primaryGreenText: { color: C.black, fontWeight: "900", fontSize: 14, letterSpacing: 1.1 },
  secondaryDark: { minHeight: 46, borderRadius: 10, backgroundColor: C.panel2, alignItems: "center", justifyContent: "center", paddingHorizontal: 18, marginTop: 8 },
  secondaryDarkText: { color: C.text, fontWeight: "800", fontSize: 12, letterSpacing: .8 },
  remoteScreen: { backgroundColor: C.bg, padding: 12, paddingBottom: 30 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  deviceBadge: { flexDirection: "row", alignItems: "center", gap: 9 },
  deviceDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.green },
  deviceName: { color: C.text, fontSize: 16, fontWeight: "800" },
  deviceIp: { color: C.muted, fontSize: 11, marginTop: 1 },
  gear: { width: 42, height: 42, backgroundColor: C.panel, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  gearText: { color: C.text, fontSize: 20 },
  modeRow: { flexDirection: "row", backgroundColor: C.panel, borderRadius: 10, padding: 3, marginBottom: 10 },
  modeTab: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  modeTabActive: { backgroundColor: C.green },
  modeTabText: { color: C.muted, fontWeight: "800", fontSize: 11 },
  modeTabTextActive: { color: C.black },
  functionRow: { flexDirection: "row", gap: 7, marginBottom: 9 },
  keyButton: { flex: 1, minHeight: 48, borderRadius: 7, backgroundColor: C.key, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#444" },
  keyButtonWide: { minWidth: 58 },
  keyButtonGreen: { backgroundColor: C.greenDark, borderColor: C.green },
  keyButtonPressed: { backgroundColor: C.keyPressed, transform: [{ scale: 0.98 }] },
  keyText: { color: C.text, fontSize: 12, fontWeight: "900", letterSpacing: .35 },
  dpadPanel: { backgroundColor: C.panel, borderRadius: 18, paddingVertical: 15, alignItems: "center", marginBottom: 10, borderWidth: 1, borderColor: "#383838" },
  dpadMiddle: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 10 },
  arrowButton: { width: 70, height: 58, borderRadius: 15, backgroundColor: C.key, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#444" },
  arrowText: { color: C.text, fontSize: 22, fontWeight: "900" },
  okButton: { width: 76, height: 76, borderRadius: 38, backgroundColor: C.green, alignItems: "center", justifyContent: "center", borderWidth: 4, borderColor: "#A9D95C" },
  okText: { color: C.black, fontSize: 17, fontWeight: "900" },
  avRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  levelBlock: { flex: 1, backgroundColor: C.panel, padding: 8, borderRadius: 12 },
  levelTitle: { color: C.muted, fontSize: 10, fontWeight: "900", letterSpacing: 1, textAlign: "center", marginBottom: 6 },
  levelRow: { flexDirection: "row", gap: 5 },
  numericHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  sectionTitle: { color: C.text, fontWeight: "900", fontSize: 12 },
  linkText: { color: C.green, fontSize: 10, fontWeight: "900" },
  numericGrid: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginBottom: 10 },
  mediaRow: { flexDirection: "row", gap: 7, marginBottom: 8 },
  colorRow: { flexDirection: "row", gap: 7 },
  twoCol: { flexDirection: "row", gap: 8 },
  trackpadWrap: { gap: 10 },
  trackpadSurface: { height: 330, backgroundColor: C.panel, borderRadius: 20, borderWidth: 1, borderColor: "#3D3D3D", alignItems: "center", justifyContent: "center" },
  trackpadIcon: { color: C.green, fontSize: 44, marginBottom: 10 },
  trackpadText: { color: C.text, fontWeight: "900", letterSpacing: 1 },
  trackpadSub: { color: C.muted, marginTop: 6 },
  screenCard: { backgroundColor: C.panel, borderRadius: 18, padding: 26, alignItems: "center", minHeight: 430, justifyContent: "center" },
  screenIcon: { color: C.green, fontSize: 52 },
  screenTitle: { color: C.text, fontSize: 22, fontWeight: "900", marginTop: 10 },
  screenBody: { color: C.muted, textAlign: "center", lineHeight: 20, marginVertical: 14 },
  statusBar: { flexDirection: "row", alignItems: "center", backgroundColor: C.panel, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 9, marginTop: 12 },
  statusText: { color: C.text, fontSize: 11, flex: 1, marginLeft: 8 },
  statusPort: { color: C.muted, fontSize: 10 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,.68)", justifyContent: "flex-end" },
  sheet: { backgroundColor: C.panel, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 30 },
  sheetTitle: { color: C.text, fontSize: 20, fontWeight: "900", marginBottom: 14 },
  sheetLabel: { color: C.muted, fontSize: 11, fontWeight: "800", marginTop: 9, marginBottom: 5 },
  input: { backgroundColor: C.key, borderRadius: 8, color: C.text, paddingHorizontal: 12, paddingVertical: 12 },
  cancelText: { color: C.muted, fontWeight: "800", textAlign: "center", marginTop: 14, paddingVertical: 8 },
  connectedLine: { color: C.green, fontSize: 12, fontWeight: "800", marginBottom: 8 },
  channelBig: { color: C.text, fontSize: 40, fontWeight: "900", textAlign: "center", marginBottom: 12 },
});