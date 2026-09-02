import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { accessHello } from "@/lib/access-control";
import { probeStbAtHost, scanSubnetForStbs, type SubnetScanProgress } from "@/lib/unicast-discovery";
import { resolveVinputEndpoint, startVinput } from "@/lib/vinput-control";
import { DEFAULT_KEYS, KeyCode, MOCK_DEVICE, type KeyAction, type StbDevice } from "@/lib/stb-protocol";
import { VinputTransport } from "@/lib/vinput-transport";

const C = { bg: "#0B1118", panel: "#131D28", elevated: "#1B2938", text: "#F5F8FB", muted: "#9AAABD", blue: "#5B9BFF", green: "#48D597", border: "#273747" };

function Key({ label, symbol, onPress }: { label: string; symbol?: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.key, pressed && styles.pressed]}><Text style={styles.keyLabel}>{symbol ?? label}</Text><Text style={styles.keySub}>{label}</Text></Pressable>;
}

export default function ClaudeScreen() {
  const [device, setDevice] = useState<StbDevice | null>(null);
  const [phase, setPhase] = useState("Ready to scan");
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState(MOCK_DEVICE.host);
  const [progress, setProgress] = useState<SubnetScanProgress | null>(null);
  const [transport, setTransport] = useState<VinputTransport | null>(null);

  const connect = async (found: StbDevice) => {
    setPhase(`Found ${found.name} @ ${found.host}. Connecting…`);
    const hello = await accessHello(found);
    setPhase(hello.ok ? "AccessHello OK. Starting Vinput…" : "AccessHello did not confirm; trying Vinput…");
    await startVinput(found).catch(() => false);
    const endpoint = await resolveVinputEndpoint(found);
    const resolved = { ...found, vinput: endpoint };
    setDevice(resolved);
    setHost(resolved.host);
    setTransport(new VinputTransport({ host: endpoint.host, port: endpoint.port, serviceName: endpoint.serviceName }));
    setPhase(`CONNECTED · ${resolved.name} · ${resolved.host}:${endpoint.port}`);
  };

  const scan = async () => {
    if (busy) return;
    setBusy(true); setDevice(null); setProgress(null); setPhase("Scanning local /24 with unicast HTTP…"); transport?.close();
    try {
      const found = await scanSubnetForStbs(setProgress);
      if (!found.length) { setPhase("No HiSilicon STB found"); Alert.alert("No STB found", "No HiMultiScreen device answered the unicast description probe."); return; }
      await connect(found[0]);
    } catch (e) { setPhase(e instanceof Error ? e.message : "Scan failed"); }
    finally { setBusy(false); setProgress(null); }
  };

  const connectIp = async () => {
    if (busy || !host.trim()) return;
    setBusy(true); setPhase(`Probing ${host.trim()}…`);
    try {
      const found = await probeStbAtHost(host.trim());
      if (!found) { setPhase(`No HiMultiScreen description at ${host.trim()}`); return; }
      await connect(found);
    } catch (e) { setPhase(e instanceof Error ? e.message : "Connection failed"); }
    finally { setBusy(false); }
  };

  if (!device || !transport) return (
    <ScreenContainer edges={["top", "left", "right", "bottom"]} containerClassName="bg-background">
      <View style={styles.discovery}>
        <Text style={styles.eyebrow}>STB REMOTE · CLAUDE BUILD</Text>
        <Text style={styles.title}>Find your STB</Text>
        <Text style={styles.sub}>Unicast-only discovery test. Nothing is enabled until a real HiMultiScreen device is found and connected.</Text>
        <View style={styles.card}>
          {busy ? <ActivityIndicator color={C.blue} size="large" /> : <View style={styles.dot} />}
          <Text style={styles.phase}>{phase}</Text>
          {progress ? <Text style={styles.progress}>{progress.checked} / {progress.total} addresses checked</Text> : null}
        </View>
        <Pressable disabled={busy} onPress={scan} style={[styles.primary, busy && styles.disabled]}><Text style={styles.primaryText}>{busy ? "SCANNING…" : "SCAN NETWORK"}</Text></Pressable>
        <Text style={styles.or}>or connect directly</Text>
        <View style={styles.ipRow}><TextInput value={host} onChangeText={setHost} keyboardType="numbers-and-punctuation" style={styles.input} placeholder="192.168.1.11" placeholderTextColor={C.muted}/><Pressable disabled={busy} onPress={connectIp} style={styles.connectBtn}><Text style={styles.connectText}>CONNECT</Text></Pressable></View>
      </View>
    </ScreenContainer>
  );

  const send = (action: KeyAction) => transport.sendTap(action.keyCode);
  const key = (label: string) => new Map(DEFAULT_KEYS.map((item) => [item.label, item])).get(label) ?? { label, keyCode: 0, symbol: "" };
  return (
    <ScreenContainer edges={["top", "left", "right", "bottom"]} containerClassName="bg-background">
      <ScrollView contentContainerStyle={styles.remote}>
        <View style={styles.top}><View><Text style={styles.eyebrow}>CONNECTED</Text><Text style={styles.titleSmall}>{device.name}</Text><Text style={styles.ip}>{device.host}</Text></View><Pressable onPress={() => { transport.close(); setTransport(null); setDevice(null); setPhase("Ready to scan"); }} style={styles.disconnect}><Text style={styles.disconnectText}>DISCONNECT</Text></Pressable></View>
        <View style={styles.dpad}><Key label="UP" symbol="▲" onPress={() => send({label:"Up",keyCode:KeyCode.DPAD_UP,symbol:"▲"})}/><View style={styles.dpadRow}><Key label="LEFT" symbol="◀" onPress={() => send({label:"Left",keyCode:KeyCode.DPAD_LEFT,symbol:"◀"})}/><Pressable onPress={() => send({label:"OK",keyCode:KeyCode.ENTER,symbol:"OK"})} style={styles.ok}><Text style={styles.okText}>OK</Text></Pressable><Key label="RIGHT" symbol="▶" onPress={() => send({label:"Right",keyCode:KeyCode.DPAD_RIGHT,symbol:"▶"})}/></View><Key label="DOWN" symbol="▼" onPress={() => send({label:"Down",keyCode:KeyCode.DPAD_DOWN,symbol:"▼"})}/></View>
        <View style={styles.grid}><Key label="BACK" onPress={() => send({label:"Back",keyCode:KeyCode.BACK,symbol:"↩"})}/><Key label="HOME" onPress={() => send({label:"Home",keyCode:KeyCode.HOME,symbol:"⌂"})}/><Key label="INFO" onPress={() => send(key("Info"))}/><Key label="GUIDE" onPress={() => send(key("Guide"))}/><Key label="VOL +" onPress={() => send(key("Volume +"))}/><Key label="MUTE" onPress={() => send(key("Mute"))}/><Key label="VOL −" onPress={() => send(key("Volume −"))}/><Key label="CH +" onPress={() => send(key("Channel +"))}/><Key label="CH −" onPress={() => send(key("Channel −"))}/><Key label="PLAY" onPress={() => send({label:"Play",keyCode:KeyCode.PLAY,symbol:"▶"})}/><Key label="STOP" onPress={() => send({label:"Stop",keyCode:KeyCode.STOP,symbol:"■"})}/><Key label="POWER" onPress={() => send({label:"Power",keyCode:KeyCode.POWER,symbol:"⏻"})}/></View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  discovery:{flex:1,backgroundColor:C.bg,padding:24,justifyContent:"center"}, eyebrow:{color:C.green,fontSize:11,fontWeight:"900",letterSpacing:1.5}, title:{color:C.text,fontSize:34,fontWeight:"900",marginTop:5}, sub:{color:C.muted,fontSize:14,lineHeight:21,marginTop:8,marginBottom:20}, card:{backgroundColor:C.panel,borderWidth:1,borderColor:C.border,borderRadius:22,padding:24,alignItems:"center"}, dot:{width:18,height:18,borderRadius:9,backgroundColor:C.green,marginBottom:10}, phase:{color:C.text,fontSize:16,fontWeight:"800",textAlign:"center",marginTop:10},progress:{color:C.muted,marginTop:10},primary:{marginTop:14,minHeight:54,borderRadius:16,backgroundColor:C.blue,alignItems:"center",justifyContent:"center"},primaryText:{color:"#fff",fontWeight:"900"},disabled:{opacity:.5},or:{color:C.muted,textAlign:"center",marginVertical:14},ipRow:{flexDirection:"row",gap:8},input:{flex:1,backgroundColor:C.panel,borderWidth:1,borderColor:C.border,borderRadius:14,color:C.text,paddingHorizontal:14,fontSize:15},connectBtn:{paddingHorizontal:16,borderRadius:14,backgroundColor:C.elevated,justifyContent:"center",borderWidth:1,borderColor:C.border},connectText:{color:C.blue,fontWeight:"900",fontSize:12},remote:{padding:16,paddingBottom:30},top:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",marginBottom:14},titleSmall:{color:C.text,fontSize:24,fontWeight:"900",marginTop:3},ip:{color:C.muted,fontSize:12,marginTop:2},disconnect:{paddingHorizontal:10,paddingVertical:9,borderRadius:10,backgroundColor:C.panel,borderWidth:1,borderColor:C.border},disconnectText:{color:C.muted,fontSize:10,fontWeight:"900"},dpad:{backgroundColor:C.panel,borderWidth:1,borderColor:C.border,borderRadius:24,alignItems:"center",padding:18},dpadRow:{flexDirection:"row",alignItems:"center",gap:10,marginVertical:10},key:{flex:1,minHeight:58,borderRadius:16,backgroundColor:C.elevated,borderWidth:1,borderColor:C.border,alignItems:"center",justifyContent:"center",paddingHorizontal:6},keyLabel:{color:C.text,fontSize:20,fontWeight:"900"},keySub:{color:C.muted,fontSize:9,fontWeight:"800",marginTop:2},pressed:{opacity:.7,transform:[{scale:.97}]},ok:{width:76,height:76,borderRadius:38,backgroundColor:C.blue,alignItems:"center",justifyContent:"center"},okText:{color:"#fff",fontWeight:"900",fontSize:17},grid:{flexDirection:"row",flexWrap:"wrap",gap:8,marginTop:12},
});
