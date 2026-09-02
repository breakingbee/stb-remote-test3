import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Network from "expo-network";

import { postSoapAction } from "@/lib/soap-client";
import { ACCESS_SERVICE_TYPE, CLIENT_VERSION, type StbDevice } from "@/lib/stb-protocol";

/**
 * Access-control ("pairing") handshake — AccessUpnpController.java.
 *
 * Before the STB's input driver will act on Vinput UDP packets, some firmware builds
 * require the app to register itself via a "Hello" SOAP action carrying a stable
 * RemoteID (the reference Android app uses the phone's WiFi MAC address for this).
 * The STB echoes the RemoteID back to confirm the pairing, and expects a periodic
 * "Ping" to keep the session alive plus a "Byebye" on disconnect.
 *
 * iOS does not expose the device's real WiFi MAC address to apps (has not since
 * iOS 7) — Apple returns a constant placeholder for privacy. We generate a random,
 * locally-administered-looking MAC string once and persist it, which is exactly as
 * valid to the STB: it only ever compares RemoteID for equality, never validates it
 * against real hardware.
 */

const REMOTE_ID_STORAGE_KEY = "stb-remote/remote-id";

function randomHexByte(): string {
  return Math.floor(Math.random() * 256)
    .toString(16)
    .padStart(2, "0");
}

function generateLocalRemoteId(): string {
  // 0x02 prefix marks a "locally administered" MAC per IEEE 802 — never collides
  // with a real vendor-assigned address, which keeps intent obvious in STB logs.
  const bytes = ["02", randomHexByte(), randomHexByte(), randomHexByte(), randomHexByte(), randomHexByte()];
  return bytes.join(":");
}

export async function getOrCreateRemoteId(): Promise<string> {
  const existing = await AsyncStorage.getItem(REMOTE_ID_STORAGE_KEY);
  if (existing) return existing;
  const created = generateLocalRemoteId();
  await AsyncStorage.setItem(REMOTE_ID_STORAGE_KEY, created);
  return created;
}

export type HelloResult = {
  ok: boolean;
  remoteId: string;
  supportsHme?: boolean;
  supportedVideoType?: string;
  error?: string;
};

/** AccessUpnpController.accessHello() */
export async function accessHello(device: StbDevice): Promise<HelloResult> {
  const controlUrl = device.services?.access?.controlUrl;
  const remoteId = await getOrCreateRemoteId();
  if (!controlUrl) {
    return { ok: false, remoteId, error: "no_access_control_service" };
  }

  let localIp = "0.0.0.0";
  try {
    localIp = (await Network.getIpAddressAsync()) || localIp;
  } catch {
    // best-effort; the STB mostly cares that *some* IP string is present
  }

  const result = await postSoapAction(controlUrl, ACCESS_SERVICE_TYPE, "Hello", {
    RemoteID: remoteId,
    RemoteIP: localIp,
    Version: CLIENT_VERSION,
    DeviceInfo: "iOS Remote",
    SDKVersion: "0",
  });

  if (!result.ok) {
    return { ok: false, remoteId, error: result.error ?? `http_${result.status}` };
  }

  const currentRemoteId = result.args.CurrentRemoteID;
  return {
    ok: currentRemoteId === remoteId,
    remoteId,
    supportsHme: result.args.SupportHME === "1",
    supportedVideoType: result.args.SupportVideo,
  };
}

/** AccessUpnpController.accessPing() — call roughly every 1.5s while connected. */
export async function accessPing(device: StbDevice, remoteId: string, startedAtMs: number) {
  const controlUrl = device.services?.access?.controlUrl;
  if (!controlUrl) return { ok: false as const };
  const result = await postSoapAction(controlUrl, ACCESS_SERVICE_TYPE, "Ping", {
    RemoteID: remoteId,
    PingTime: Date.now() - startedAtMs,
  });
  return { ok: result.ok, args: result.args };
}

/** AccessUpnpController.accessByebye() — call on disconnect / app background. */
export async function accessByebye(device: StbDevice, remoteId: string) {
  const controlUrl = device.services?.access?.controlUrl;
  if (!controlUrl) return { ok: false as const };
  const result = await postSoapAction(controlUrl, ACCESS_SERVICE_TYPE, "Byebye", { RemoteID: remoteId });
  return { ok: result.ok };
}
