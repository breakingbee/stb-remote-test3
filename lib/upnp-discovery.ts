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

type Socket = {
  bind: (port?: number, address?: string, callback?: () => void) => void;
  close: () => void;
  on: (event: "message", handler: (message: Uint8Array, remote: { address: string; port: number }) => void) => void;
  send: (message: Uint8Array, offset: number, length: number, port: number, host: string, callback?: (error?: Error) => void) => void;
  addMembership?: (multicastAddress: string, multicastInterface?: string) => void;
  dropMembership?: (multicastAddress: string, multicastInterface?: string) => void;
};
type Dgram = { createSocket: (options: { type: "udp4", reuseAddr?: boolean }) => Socket };

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const HI_HTTP_PORTS = [2015, 8867];
const HI_DESCRIPTION_PATHS = ["/description.xml", "/desc.xml", "/rootDesc.xml", "/device.xml"];
const LOG_LIMIT = 300;

let logEntries: DiscoveryLogEntry[] = [];
const logListeners = new Set<(entries: DiscoveryLogEntry[]) => void>();

function discoveryLog(level: DiscoveryLevel, message: string) {
  const entry = { time: new Date().toLocaleTimeString(), level, message };
  logEntries = [...logEntries.slice(-(LOG_LIMIT - 1)), entry];
  for (const listener of logListeners) listener(logEntries);
  // Keep native console logging as well for Xcode/device logs.
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

function parseSsdpPacket(text: string) {
  return {
    location: header(text, "LOCATION"),
    server: header(text, "SERVER"),
    usn: header(text, "USN"),
    st: header(text, "ST"),
    nt: header(text, "NT"),
    nts: header(text, "NTS"),
  };
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
  const response = await fetchWithTimeout(url, 700);
  if (!response) {
    discoveryLog("warn", `No HTTP response from ${url}`);
    return null;
  }

  let body = "";
  try {
    body = await response.text();
  } catch {
    discoveryLog("warn", `Could not read HTTP body from ${url}`);
    return null;
  }

  if (!/<(?:root|device)\\b/i.test(body) || !/<serviceType>/i.test(body)) {
    discoveryLog("warn", `HTTP ${url} responded, but it is not a UPnP device description.`);
    return null;
  }

  const parsed = parseDeviceDescription(body, url);
  const vinput = parsed.services.find((s) => s.serviceType === VINPUT_SERVICE_TYPE);
  const access = parsed.services.find((s) => s.serviceType.includes("AccessControlServer"));
  const mirror = parsed.services.find((s) => s.serviceType.includes("MirrorControlServer"));

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
  discoveryLog("info", `Services: access=${Boolean(access)} vinput=${Boolean(vinput)} mirror=${Boolean(mirror)}`);
  return device;
}

async function resolveDevice(host: string, location?: string, server?: string): Promise<StbDevice | null> {
  discoveryLog("info", `Resolving device ${host}${location ? ` from LOCATION=${location}` : ""}`);
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

async function createSsdpListener(timeoutMs: number) {
  const dgram = loadDgram();
  if (!dgram) return null;

  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const responses = new Map<string, { location?: string; server?: string; usn?: string; st?: string; nt?: string; nts?: string }>();
  let closed = false;

  socket.on("message", (message, remote) => {
    const text = decodeMessage(message);
    const packet = parseSsdpPacket(text);
    const host = normalizeHost(remote.address);
    responses.set(host, packet);
    const firstLine = text.split(/\\r?\\n/, 1)[0] ?? "SSDP packet";
    discoveryLog("ok", `SSDP from ${host}: ${firstLine}`);
    if (packet.nts) discoveryLog("info", `NOTIFY NTS=${packet.nts} NT=${packet.nt ?? "?"}`);
    if (packet.location) discoveryLog("info", `LOCATION=${packet.location}`);
    if (packet.usn) discoveryLog("info", `USN=${packet.usn}`);
  });

  await new Promise<void>((resolve) => {
    socket.bind(SSDP_PORT, "0.0.0.0", () => {
      discoveryLog("ok", `SSDP listener bound to UDP ${SSDP_PORT}.`);
      try {
        if (!socket.addMembership) {
          discoveryLog("warn", "UDP socket has no addMembership() support; NOTIFY multicast cannot be joined.");
        } else {
          socket.addMembership(SSDP_ADDRESS);
          discoveryLog("ok", `Joined SSDP multicast ${SSDP_ADDRESS}:${SSDP_PORT}. Listening for NOTIFY.`);
        }
      } catch (error) {
        discoveryLog("error", `Could not join SSDP multicast ${SSDP_ADDRESS}: ${String(error)}`);
        discoveryLog("warn", "iOS multicast entitlement/permission may be blocking unsolicited NOTIFY packets.");
      }
      resolve();
    });
  });

  const timer = setTimeout(() => {
    if (closed) return;
    closed = true;
    try {
      socket.dropMembership?.(SSDP_ADDRESS);
    } catch {
      // Ignore drop errors.
    }
    try {
      socket.close();
    } catch {
      // Ignore close errors.
    }
    discoveryLog("info", `SSDP listener stopped after ${timeoutMs} ms; received ${responses.size} unique hosts.`);
  }, timeoutMs);

  return {
    socket,
    responses,
    stop: () => {
      clearTimeout(timer);
      if (closed) return;
      closed = true;
      try {
        socket.dropMembership?.(SSDP_ADDRESS);
      } catch {
        // Ignore.
      }
      try {
        socket.close();
      } catch {
        // Ignore.
      }
    },
  };
}

async function ssdpSearchOnSocket(
  socket: Socket,
  destinations: string[],
  searchTargets: string[],
): Promise<void> {
  for (const target of searchTargets) {
    for (const destination of destinations) {
      const request = buildSearchRequest(target, destination);
      discoveryLog("info", `Sending M-SEARCH ST=${target} → ${destination}:${SSDP_PORT}`);
      socket.send(request, 0, request.length, SSDP_PORT, destination, (error) => {
        if (error) discoveryLog("warn", `M-SEARCH send failed to ${destination}: ${error.message}`);
      });
    }
  }
}

async function unicastSsdpProbe(localIp: string, listenerTimeoutMs = 1800) {
  const dgram = loadDgram();
  if (!dgram) return new Map<string, { location?: string; server?: string; usn?: string; st?: string; nt?: string; nts?: string }>();

  const socket = dgram.createSocket({ type: "udp4" });
  const responses = new Map<string, { location?: string; server?: string; usn?: string; st?: string; nt?: string; nts?: string }>();
  const parts = localIp.split(".");
  if (parts.length !== 4) return responses;
  const prefix = parts.slice(0, 3).join(".");
  const destinations = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((ip) => ip !== localIp);
  const targets = [MULTISCREEN_DEVICE_TYPE, "upnp:rootdevice", "ssdp:all"];

  socket.on("message", (message, remote) => {
    const packet = parseSsdpPacket(decodeMessage(message));
    responses.set(normalizeHost(remote.address), packet);
    discoveryLog("ok", `UNICAST SSDP response from ${remote.address}${packet.location ? ` LOCATION=${packet.location}` : ""}`);
  });

  await new Promise<void>((resolve) => {
    socket.bind(0, "0.0.0.0", async () => {
      discoveryLog("info", `Unicast SSDP fallback bound. Probing ${destinations.length} LAN addresses.`);
      for (let i = 0; i < destinations.length; i += 32) {
        await ssdpSearchOnSocket(socket, destinations.slice(i, i + 32), targets);
        await new Promise((r) => setTimeout(r, 50));
        if (responses.size) break;
      }
      resolve();
    });
  });

  await new Promise((r) => setTimeout(r, listenerTimeoutMs));
  try { socket.close(); } catch { /* ignore */ }
  return responses;
}

async function httpSubnetProbe(localIp: string): Promise<StbDevice[]> {
  const parts = localIp.split(".");
  if (parts.length !== 4) return [];
  const prefix = parts.slice(0, 3).join(".");
  const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((ip) => ip !== localIp);
  const found = new Map<string, StbDevice>();

  discoveryLog("info", `HTTP fallback: probing ${hosts.length} LAN addresses on ports ${HI_HTTP_PORTS.join(", ")}.`);
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

export async function discoverHiSiliconStbs(timeoutMs = 2200): Promise<StbDevice[]> {
  clearDiscoveryLogs();
  discoveryLog("info", "=== HiControl-style discovery started ===");

  let localIp = "";
  try {
    localIp = await Network.getIpAddressAsync();
    discoveryLog("info", `Local IPv4 reported by expo-network: ${localIp || "none"}`);
  } catch (error) {
    discoveryLog("warn", `Could not read local IP: ${String(error)}`);
  }

  const listener = await createSsdpListener(timeoutMs);

  if (listener) {
    const dgram = loadDgram();
    if (dgram) {
      const searchSocket = dgram.createSocket({ type: "udp4" });
      await new Promise<void>((resolve) => {
        searchSocket.bind(0, "0.0.0.0", async () => {
          discoveryLog("ok", "M-SEARCH sender socket bound.");
          try {
            await ssdpSearchOnSocket(searchSocket, [SSDP_ADDRESS], [MULTISCREEN_DEVICE_TYPE, "upnp:rootdevice", "ssdp:all"]);
          } finally {
            setTimeout(() => {
              try { searchSocket.close(); } catch { /* ignore */ }
            }, 50);
            resolve();
          }
        });
      });
    }
  }

  await new Promise((r) => setTimeout(r, timeoutMs));

  let responses = listener?.responses ?? new Map<string, { location?: string; server?: string; usn?: string; st?: string; nt?: string; nts?: string }>();
  listener?.stop();

  if (responses.size) {
    discoveryLog("ok", `SSDP discovery produced ${responses.size} host(s). Resolving device descriptions.`);
    const devices: StbDevice[] = [];
    for (const [host, info] of responses) {
      const device = await resolveDevice(host, info.location, info.server);
      if (device) devices.push(device);
    }
    if (devices.length) {
      discoveryLog("ok", `Discovery finished successfully: ${devices.length} HiSilicon device(s).`);
      return devices;
    }
  } else {
    discoveryLog("warn", "No SSDP response/NOTIFY was received from the multicast listener.");
  }

  if (localIp && /^\d+\.\d+\.\d+\.\d+$/.test(localIp)) {
    discoveryLog("info", "Trying unicast SSDP, because multicast discovery returned no device.");
    responses = await unicastSsdpProbe(localIp, 900);
    if (responses.size) {
      const devices: StbDevice[] = [];
      for (const [host, info] of responses) {
        const device = await resolveDevice(host, info.location, info.server);
        if (device) devices.push(device);
      }
      if (devices.length) {
        discoveryLog("ok", `Unicast SSDP found ${devices.length} device(s).`);
        return devices;
      }
    }

    discoveryLog("info", "Trying direct HiMultiScreen HTTP discovery as final fallback.");
    const httpDevices = await httpSubnetProbe(localIp);
    if (httpDevices.length) {
      discoveryLog("ok", `HTTP discovery found ${httpDevices.length} device(s).`);
      return httpDevices;
    }
  }

  discoveryLog("error", "=== Discovery finished: no HiSilicon STB found ===");
  return [];
}
