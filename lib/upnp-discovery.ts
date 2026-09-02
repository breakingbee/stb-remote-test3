import { Platform } from "react-native";
import * as Network from "expo-network";

import {
  MULTISCREEN_DEVICE_TYPE,
  VINPUT_DEFAULT_PORT,
  VINPUT_SERVICE_TYPE,
  type StbDevice,
} from "@/lib/stb-protocol";
import { parseDeviceDescription } from "@/lib/xml-lite";

type DiscoveryLevel = "info" | "ok" | "warn" | "error";
export type DiscoveryLogEntry = { time: string; level: DiscoveryLevel; message: string };

type SsdpPacket = {
  location?: string;
  server?: string;
  usn?: string;
  st?: string;
  nt?: string;
  nts?: string;
};

type Socket = {
  bind: (port?: number, address?: string, callback?: () => void) => void;
  close: () => void;
  on: (
    event: "message",
    handler: (message: Uint8Array, remote: { address: string; port: number }) => void,
  ) => void;
  send: (
    message: Uint8Array,
    offset: number,
    length: number,
    port: number,
    host: string,
    callback?: (error?: Error) => void,
  ) => void;
  addMembership?: (multicastAddress: string, multicastInterface?: string) => void;
  dropMembership?: (multicastAddress: string, multicastInterface?: string) => void;
};

type Dgram = {
  createSocket: (options: { type: "udp4"; reusePort?: boolean }) => Socket;
};

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [MULTISCREEN_DEVICE_TYPE, "upnp:rootdevice", "ssdp:all"];
const HI_HTTP_PORTS = [2015, 8867];
const HI_DESCRIPTION_PATHS = [
  "/description.xml",
  "/desc.xml",
  "/rootDesc.xml",
  "/rootdesc.xml",
  "/device.xml",
  "/upnp/description.xml",
  "/",
];
const LOG_LIMIT = 500;

let logEntries: DiscoveryLogEntry[] = [];
const logListeners = new Set<(entries: DiscoveryLogEntry[]) => void>();
const deviceListeners = new Set<(device: StbDevice) => void>();
const knownDevices = new Map<string, StbDevice>();
let persistentListener: { socket: Socket; stop: () => void } | null = null;

function discoveryLog(level: DiscoveryLevel, message: string) {
  const entry: DiscoveryLogEntry = {
    time: new Date().toLocaleTimeString(),
    level,
    message,
  };
  logEntries = [...logEntries.slice(-(LOG_LIMIT - 1)), entry];
  for (const listener of logListeners) listener(logEntries);
  console.log(`[STB DISCOVERY][${level.toUpperCase()}] ${message}`);
}

export function getDiscoveryLogs() {
  return [...logEntries];
}

export function subscribeDiscoveryLogs(listener: (entries: DiscoveryLogEntry[]) => void) {
  logListeners.add(listener);
  listener(logEntries);
  return () => logListeners.delete(listener);
}

export function clearDiscoveryLogs() {
  logEntries = [];
  for (const listener of logListeners) listener(logEntries);
}

export function subscribeDiscoveredDevices(listener: (device: StbDevice) => void) {
  deviceListeners.add(listener);
  for (const device of knownDevices.values()) listener(device);
  return () => deviceListeners.delete(listener);
}

function loadDgram(): Dgram | null {
  if (Platform.OS === "web") {
    discoveryLog("warn", "UDP discovery unavailable on web platform.");
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("react-native-udp").default ?? require("react-native-udp");
  } catch (error) {
    discoveryLog("error", `Unable to load react-native-udp: ${String(error)}`);
    return null;
  }
}

function decodeMessage(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes);
}

function header(text: string, name: string) {
  const match = text.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function normalizeHost(host: string) {
  return host.trim().replace(/^\[|\]$/g, "");
}

function parseSsdpPacket(text: string): SsdpPacket {
  return {
    location: header(text, "LOCATION"),
    server: header(text, "SERVER"),
    usn: header(text, "USN"),
    st: header(text, "ST"),
    nt: header(text, "NT"),
    nts: header(text, "NTS"),
  };
}

function isHiMultiScreenPacket(text: string, packet: SsdpPacket) {
  return (
    packet.st === MULTISCREEN_DEVICE_TYPE ||
    /HiMultiScreen|HiMultiScreenHTTP|MultiScreenServer|VinputControlServer|MirrorControlServer|AccessControlServer/i.test(
      `${packet.server ?? ""}\n${packet.usn ?? ""}\n${packet.nt ?? ""}\n${text}`,
    )
  );
}

function buildSearchRequest(st: string, destination: string) {
  return new TextEncoder().encode(
    [
      "M-SEARCH * HTTP/1.1",
      `HOST: ${destination}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      "MX: 2",
      `ST: ${st}`,
      "",
      "",
    ].join("\r\n"),
  );
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function parseDescription(host: string, url: string, server?: string): Promise<StbDevice | null> {
  discoveryLog("info", `HTTP probe ${url}`);
  const response = await fetchWithTimeout(url, 900);
  if (!response) {
    discoveryLog("warn", `No HTTP response from ${url}`);
    return null;
  }

  let body = "";
  try {
    body = await response.text();
  } catch (error) {
    discoveryLog("warn", `Could not read HTTP body from ${url}: ${String(error)}`);
    return null;
  }

  discoveryLog("ok", `HTTP ${response.status} from ${url} (${body.length} bytes)`);
  if (!/<(?:root|device)\b/i.test(body) || !/<serviceType>/i.test(body)) {
    discoveryLog("warn", `HTTP ${url} returned data, but not a UPnP device description.`);
    return null;
  }

  const parsed = parseDeviceDescription(body, url);
  const vinput = parsed.services.find((service) => service.serviceType === VINPUT_SERVICE_TYPE);
  const access = parsed.services.find((service) => service.serviceType.includes("AccessControlServer"));
  const mirror = parsed.services.find((service) => service.serviceType.includes("MirrorControlServer"));

  const device: StbDevice = {
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

  discoveryLog("ok", `UPnP device parsed: ${device.name} @ ${device.host}`);
  discoveryLog("info", `Services access=${Boolean(access)} vinput=${Boolean(vinput)} mirror=${Boolean(mirror)}`);
  return device;
}

async function resolveDevice(host: string, location?: string, server?: string): Promise<StbDevice | null> {
  discoveryLog("info", `Resolving ${host}${location ? ` using LOCATION=${location}` : " without LOCATION"}`);
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
  discoveryLog("warn", `Could not resolve descriptor for ${host}`);
  return null;
}

async function handleSsdpPacket(text: string, remote: { address: string; port: number }) {
  const host = normalizeHost(remote.address);
  const packet = parseSsdpPacket(text);
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "SSDP packet";

  discoveryLog("ok", `SSDP packet from ${host}:${remote.port} → ${firstLine}`);
  if (packet.nts) discoveryLog("info", `NOTIFY NTS=${packet.nts} NT=${packet.nt ?? "?"}`);
  if (packet.location) discoveryLog("info", `LOCATION=${packet.location}`);
  if (packet.usn) discoveryLog("info", `USN=${packet.usn}`);

  if (!isHiMultiScreenPacket(text, packet)) {
    discoveryLog("info", `Ignoring non-HiMultiScreen SSDP packet from ${host}`);
    return;
  }

  discoveryLog("ok", `HiMultiScreen advertisement/response identified from ${host}`);
  const device = await resolveDevice(host, packet.location, packet.server);
  if (!device) return;

  knownDevices.set(host, device);
  discoveryLog("ok", `DISCOVERED: ${device.name} @ ${host}`);
  for (const listener of deviceListeners) listener(device);
}

async function ensurePersistentSsdpListener() {
  if (persistentListener) return persistentListener;

  const dgram = loadDgram();
  if (!dgram) return null;

  const socket = dgram.createSocket({ type: "udp4", reusePort: true });
  let closed = false;

  socket.on("message", (message, remote) => {
    void handleSsdpPacket(decodeMessage(message), remote).catch((error) => {
      discoveryLog("error", `SSDP handler error: ${String(error)}`);
    });
  });

  const bound = await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    socket.bind(SSDP_PORT, "0.0.0.0", () => done(true));
    setTimeout(() => done(false), 1600);
  });

  if (!bound) {
    discoveryLog("error", `SSDP listener FAILED to bind UDP ${SSDP_PORT}.`);
    try { socket.close(); } catch { /* ignore */ }
    return null;
  }

  discoveryLog("ok", `SSDP listener BOUND on UDP ${SSDP_PORT}.`);

  if (!socket.addMembership) {
    discoveryLog("error", "react-native-udp exposes no addMembership() on this build; NOTIFY cannot be joined.");
  } else {
    try {
      socket.addMembership(SSDP_ADDRESS);
      discoveryLog("ok", `SSDP multicast JOINED ${SSDP_ADDRESS}:${SSDP_PORT}.`);
      discoveryLog("ok", "LISTENING continuously for unsolicited SSDP NOTIFY packets.");
    } catch (error) {
      discoveryLog("error", `SSDP multicast JOIN FAILED: ${String(error)}`);
      discoveryLog("warn", "Physical iOS multicast receive requires Apple's multicast networking entitlement.");
    }
  }

  const stop = () => {
    if (closed) return;
    closed = true;
    try { socket.dropMembership?.(SSDP_ADDRESS); } catch { /* ignore */ }
    try { socket.close(); } catch { /* ignore */ }
    if (persistentListener?.socket === socket) persistentListener = null;
    discoveryLog("info", "Persistent SSDP listener stopped.");
  };

  persistentListener = { socket, stop };
  return persistentListener;
}

async function sendSearches(socket: Socket, destination: string) {
  for (const target of SEARCH_TARGETS) {
    const request = buildSearchRequest(target, destination);
    discoveryLog("info", `M-SEARCH ${target} → ${destination}:${SSDP_PORT}`);
    socket.send(request, 0, request.length, SSDP_PORT, destination, (error) => {
      if (error) {
        discoveryLog("warn", `M-SEARCH send failed to ${destination}: ${error.message}`);
      } else {
        discoveryLog("ok", `M-SEARCH sent (${target}) → ${destination}`);
      }
    });
  }
}

export async function discoverHiSiliconStbs(timeoutMs = 7000): Promise<StbDevice[]> {
  clearDiscoveryLogs();
  discoveryLog("info", "=== HiControl-style discovery START ===");

  let localIp = "";
  try {
    localIp = await Network.getIpAddressAsync();
    discoveryLog("ok", `Local IPv4 = ${localIp || "none"}`);
  } catch (error) {
    discoveryLog("warn", `Local IP lookup failed: ${String(error)}`);
  }

  const listener = await ensurePersistentSsdpListener();
  if (!listener) discoveryLog("error", "Could not create SSDP listener socket.");

  if (listener) {
    await sendSearches(listener.socket, SSDP_ADDRESS);
    discoveryLog("info", "Waiting for multicast SSDP replies / NOTIFY…");
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (knownDevices.size > 0) return [...knownDevices.values()];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (localIp) {
    const dgram = loadDgram();
    if (dgram) {
      const parts = localIp.split(".");
      if (parts.length === 4) {
        const prefix = parts.slice(0, 3).join(".");
        const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((ip) => ip !== localIp);
        const sweep = dgram.createSocket({ type: "udp4" });
        sweep.on("message", (message, remote) => {
          void handleSsdpPacket(decodeMessage(message), remote);
        });
        await new Promise<void>((resolve) => {
          sweep.bind(0, "0.0.0.0", async () => {
            discoveryLog("info", `UNICAST M-SEARCH sweep started over ${hosts.length} hosts.`);
            for (let i = 0; i < hosts.length; i += 32) {
              await Promise.all(hosts.slice(i, i + 32).map((host) => sendSearches(sweep, host)));
              if (knownDevices.size) break;
            }
            resolve();
          });
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        try { sweep.close(); } catch { /* ignore */ }
      }
    }
  }

  if (knownDevices.size) return [...knownDevices.values()];
  discoveryLog("error", "=== Discovery finished: no HiMultiScreen device found ===");
  discoveryLog("info", "SSDP listener remains active for later NOTIFY packets.");
  return [];
}

export async function stopHiSiliconDiscovery() {
  persistentListener?.stop();
}
