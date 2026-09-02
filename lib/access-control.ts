import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Network from "expo-network";

import { postSoapAction } from "@/lib/soap-client";
import { ACCESS_SERVICE_TYPE, CLIENT_VERSION, type StbDevice } from "@/lib/stb-protocol";

const REMOTE_ID_STORAGE_KEY = "stb-remote/remote-id";
const HISILICON_DEFAULT_REMOTE_ID = "02:00:00:00:00:00";

export async function getOrCreateRemoteId(): Promise<string> {
  const existing = await AsyncStorage.getItem(REMOTE_ID_STORAGE_KEY);
  if (existing) return existing;
  // iOS does not expose the Wi-Fi MAC address. The reference HiSilicon app/device
  // stack uses Apple's privacy placeholder value, which is also what the STB log
  // shows when the Android reference app connects.
  await AsyncStorage.setItem(REMOTE_ID_STORAGE_KEY, HISILICON_DEFAULT_REMOTE_ID);
  return HISILICON_DEFAULT_REMOTE_ID;
}

export type HelloResult = {
  ok: boolean;
  remoteId: string;
  supportsHme?: boolean;
  supportedVideoType?: string;
  error?: string;
};

export async function accessHello(device: StbDevice): Promise<HelloResult> {
  const controlUrl = device.services?.access?.controlUrl;
  const remoteId = await getOrCreateRemoteId();
  if (!controlUrl) return { ok: false, remoteId, error: "no_access_control_service" };

  let localIp = "0.0.0.0";
  try { localIp = (await Network.getIpAddressAsync()) || localIp; } catch { /* best effort */ }

  const result = await postSoapAction(controlUrl, ACCESS_SERVICE_TYPE, "Hello", {
    RemoteID: remoteId,
    RemoteIP: localIp,
    Version: CLIENT_VERSION,
    DeviceInfo: "iOS Remote",
    SDKVersion: "30",
  });

  if (!result.ok) return { ok: false, remoteId, error: result.error ?? `http_${result.status}` };
  return {
    ok: result.args.CurrentRemoteID === remoteId,
    remoteId,
    supportsHme: result.args.SupportHME === "1",
    supportedVideoType: result.args.SupportVideo,
  };
}

export async function accessPing(device: StbDevice, remoteId: string, startedAtMs: number) {
  const controlUrl = device.services?.access?.controlUrl;
  if (!controlUrl) return { ok: false as const };
  const result = await postSoapAction(controlUrl, ACCESS_SERVICE_TYPE, "Ping", {
    RemoteID: remoteId,
    PingTime: Date.now() - startedAtMs,
  });
  return { ok: result.ok, args: result.args };
}

export async function accessByebye(device: StbDevice, remoteId: string) {
  const controlUrl = device.services?.access?.controlUrl;
  if (!controlUrl) return { ok: false as const };
  const result = await postSoapAction(controlUrl, ACCESS_SERVICE_TYPE, "Byebye", { RemoteID: remoteId });
  return { ok: result.ok };
}
