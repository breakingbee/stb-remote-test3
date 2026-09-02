import { Platform } from "react-native";
import * as Network from "expo-network";

import {
  MULTISCREEN_DEVICE_TYPE,
  VINPUT_DEFAULT_PORT,
  VINPUT_SERVICE_TYPE,
  type StbDevice,
} from "@/lib/stb-protocol";
import { parseDeviceDescription } from "@/lib/xml-lite";

type Socket = {
  bind: (port?: number, address?: string, callback?: () => void) => void;
  close: () => void;
  on: (event: "message", handler: (message: Uint8Array, remote: { address: string; port: number }) => void) => void;
  send: (message: Uint8Array, offset: number, length: number, port: number, host: string, callback?: (error?: Error) => void) => void;
};
type Dgram = { createSocket: (options: { type: "udp4" }) => Socket };

const HI_HTTP_PORTS = [2015, 8867];
const HI_DESCRIPTION_PATHS = ["/desc.xml", "/description.xml", "/device.xml"];

function loadDgram(): Dgram | null {
  if (Platform.OS === "web") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("react-native-udp").default ?? require("react-native-udp");
  } catch {
    return null;
  }
}

function decodeMessage(bytes: Uint8Array) { return new TextDecoder().decode(bytes); }
function header(text: string, name: string) {
  const match = text.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}
function normalizeHost(host: string) { return host.trim().replace(/^\[|\]$/g, ""); }
function buildSearchRequest(st = MULTISCREEN_DEVICE_TYPE) {
  return new TextEncoder().encode([
    "M-SEARCH * HTTP/1.1",
    "HOST: 239.255.255.250:1900",
    'MAN: "ssdp:discover"',
    "MX: 1",
    `ST: ${st}`,
    "",
    "",
  ].join("\r\n"));
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { signal: controller.signal }); }
  catch { return null; }
  finally { clearTimeout(timer); }
}

async function parseDescription(host: string, url: string, server?: string): Promise<StbDevice | null> {
  const response = await fetchWithTimeout(url, 650);
  if (!response) return null;

  let body = "";
  try { body = await response.text(); } catch { return null; }
  if (!/<(?:root|device)\b/i.test(body) || !/<serviceType>/i.test(body)) return null;

  const parsed = parseDeviceDescription(body, url);
  const vinput = parsed.services.find((s) => s.serviceType === VINPUT_SERVICE_TYPE);
  const access = parsed.services.find((s) => s.serviceType.includes("AccessControlServer"));
  const mirror = parsed.services.find((s) => s.serviceType.includes("MirrorControlServer"));

  return {
    id: parsed.udn ?? `${host}-hisilicon`,
    name: parsed.friendlyName ?? server?.split("/")[0] ?? "HiSilicon STB",
    host,
    udn: parsed.udn,
    descriptionUrl: url,
    services: {
      access: access ? { controlUrl: access.controlUrl } : undefined,
      vinput: vinput ? { controlUrl: vinput.controlUrl } : undefined,
      mirror: mirror ? { controlUrl: mirror.controlUrl } : undefined,
    },
    vinput: { host, port: VINPUT_DEFAULT_PORT, serviceName: VINPUT_SERVICE_TYPE },
  };
}

async function resolveDevice(host: string, location?: string, server?: string): Promise<StbDevice | null> {
  if (location) {
    const device = await parseDescription(host, location, server);
    if (device) return device;
  }

  for (const port of HI_HTTP_PORTS) {
    for (const path of HI_DESCRIPTION_PATHS) {
      const device = await parseDescription(host, `http://${host}:${port}${path}`, server);
      if (device) return device;
    }
  }

  return null;
}

async function ssdpSearch(destinations: string[], timeoutMs: number) {
  const dgram = loadDgram();
  if (!dgram) return new Map<string, { location?: string; server?: string }>();

  const socket = dgram.createSocket({ type: "udp4" });
  const responses = new Map<string, { location?: string; server?: string }>();
  const request = buildSearchRequest();

  return new Promise<Map<string, { location?: string; server?: string }>>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { socket.close(); } catch { /* ignore */ }
      resolve(responses);
    };

    socket.on("message", (message, remote) => {
      const text = decodeMessage(message);
      responses.set(normalizeHost(remote.address), {
        location: header(text, "LOCATION"),
        server: header(text, "SERVER"),
      });
    });

    socket.bind(0, "0.0.0.0", () => {
      for (const destination of destinations) {
        socket.send(request, 0, request.length, 1900, destination, () => undefined);
      }
    });
    setTimeout(finish, timeoutMs);
  });
}

async function httpSubnetProbe(localIp: string): Promise<StbDevice[]> {
  const parts = localIp.split(".");
  if (parts.length !== 4) return [];
  const prefix = parts.slice(0, 3).join(".");
  const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((ip) => ip !== localIp);
  const found = new Map<string, StbDevice>();

  for (let i = 0; i < hosts.length; i += 16) {
    const batch = hosts.slice(i, i + 16);
    const results = await Promise.all(batch.map(async (host) => {
      for (const port of HI_HTTP_PORTS) {
        for (const path of HI_DESCRIPTION_PATHS) {
          const device = await parseDescription(host, `http://${host}:${port}${path}`, "HiMultiScreenHTTP");
          if (device) return device;
        }
      }
      return null;
    }));
    for (const device of results) if (device) found.set(device.host, device);
    if (found.size) break;
  }

  return [...found.values()];
}

export async function discoverHiSiliconStbs(timeoutMs = 1800): Promise<StbDevice[]> {
  const responses = await ssdpSearch(["239.255.255.250"], timeoutMs);

  const devices: StbDevice[] = [];
  for (const [host, info] of responses) {
    const device = await resolveDevice(host, info.location, info.server);
    if (device) devices.push(device);
  }
  if (devices.length) return devices;

  try {
    const localIp = await Network.getIpAddressAsync();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(localIp)) {
      // First try unicast SSDP, then HTTP descriptor probing for firmware that
      // exposes HiMultiScreenHTTP but does not answer M-SEARCH.
      const parts = localIp.split(".");
      const prefix = parts.slice(0, 3).join(".");
      const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((ip) => ip !== localIp);
      for (let i = 0; i < hosts.length; i += 64) {
        const batch = await ssdpSearch(hosts.slice(i, i + 64), 500);
        for (const [host, info] of batch) {
          const device = await resolveDevice(host, info.location, info.server);
          if (device) devices.push(device);
        }
        if (devices.length) return devices;
      }

      return await httpSubnetProbe(localIp);
    }
  } catch {
    // No usable local IPv4 address.
  }

  return [];
}
