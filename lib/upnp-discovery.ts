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
  on: (
    event: "message",
    handler: (
      message: Uint8Array,
      remote: { address: string; port: number },
    ) => void,
  ) => void;
  send: (
    message: Uint8Array,
    offset: number,
    length: number,
    port: number,
    host: string,
    callback?: (error?: Error) => void,
  ) => void;
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

function decodeMessage(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes);
}

function header(text: string, name: string) {
  const match = text.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function buildSearchRequest(st = MULTISCREEN_DEVICE_TYPE) {
  return new TextEncoder().encode(
    [
      "M-SEARCH * HTTP/1.1",
      "HOST: 239.255.255.250:1900",
      'MAN: "ssdp:discover"',
      "MX: 1",
      `ST: ${st}`,
      "",
      "",
    ].join("\r\n"),
  );
}

function normalizeHost(host: string) {
  return host.trim().replace(/^\[|\]$/g, "");
}

async function fetchDescription(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 700);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return "";
    const text = await response.text();
    return /<(?:root|device)\b/i.test(text) && /<serviceType>/i.test(text) ? text : "";
  } catch {
    return "";
  }
}

async function resolveDevice(host: string, location?: string, server?: string): Promise<StbDevice> {
  let descriptionXml = "";
  let descriptionUrl = location;

  if (location) {
    descriptionXml = await fetchDescription(location);
  }

  if (!descriptionXml) {
    for (const port of HI_HTTP_PORTS) {
      for (const path of HI_DESCRIPTION_PATHS) {
        const candidate = `http://${host}:${port}${path}`;
        descriptionXml = await fetchDescription(candidate);
        if (descriptionXml) {
          descriptionUrl = candidate;
          break;
        }
      }
      if (descriptionXml) break;
    }
  }

  if (!descriptionXml) {
    return {
      id: `${host}-fallback`,
      name: server?.split("/")[0] ?? "HiSilicon STB",
      host,
      vinput: { host, port: VINPUT_DEFAULT_PORT, serviceName: VINPUT_SERVICE_TYPE },
    };
  }

  const parsed = parseDeviceDescription(descriptionXml, descriptionUrl ?? `http://${host}/`);
  const vinputService = parsed.services.find((service) => service.serviceType === VINPUT_SERVICE_TYPE);
  const accessService = parsed.services.find((service) => service.serviceType.includes("AccessControlServer"));
  const mirrorService = parsed.services.find((service) => service.serviceType.includes("MirrorControlServer"));

  return {
    id: parsed.udn ?? `${host}-${vinputService ? "vinput" : "unknown"}`,
    name: parsed.friendlyName ?? server?.split("/")[0] ?? "HiSilicon STB",
    host,
    udn: parsed.udn,
    descriptionUrl,
    services: {
      access: accessService ? { controlUrl: accessService.controlUrl } : undefined,
      vinput: vinputService ? { controlUrl: vinputService.controlUrl } : undefined,
      mirror: mirrorService ? { controlUrl: mirrorService.controlUrl } : undefined,
    },
    vinput: { host, port: VINPUT_DEFAULT_PORT, serviceName: VINPUT_SERVICE_TYPE },
  };
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

async function probeHttpHosts(localIp: string, timeoutMs: number): Promise<string[]> {
  const parts = localIp.split(".");
  if (parts.length !== 4) return [];
  const prefix = parts.slice(0, 3).join(".");
  const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((ip) => ip !== localIp);
  const found = new Set<string>();

  for (let i = 0; i < hosts.length; i += 32) {
    const batch = hosts.slice(i, i + 32);
    await Promise.all(
      batch.map(async (host) => {
        for (const port of HI_HTTP_PORTS) {
          for (const path of HI_DESCRIPTION_PATHS) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
              const response = await fetch(`http://${host}:${port}${path}`, { signal: controller.signal });
              if (!response.ok) continue;
              const text = await response.text();
              if (/<(?:root|device)\b/i.test(text) && /<serviceType>/i.test(text)) {
                found.add(host);
                return;
              }
            } catch {
              // Host/port is simply not our STB.
            } finally {
              clearTimeout(timer);
            }
          }
        }
      }),
    );
    if (found.size > 0) break;
  }

  return [...found];
}

export async function discoverHiSiliconStbs(timeoutMs = 2500): Promise<StbDevice[]> {
  const multicastResponses = await ssdpSearch(["239.255.255.250"], timeoutMs);
  const responses = new Map(multicastResponses);

  if (responses.size === 0) {
    try {
      const localIp = await Network.getIpAddressAsync();
      if (localIp && /^\d+\.\d+\.\d+\.\d+$/.test(localIp)) {
        const parts = localIp.split(".");
        const prefix = parts.slice(0, 3).join(".");
        const destinations = Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`).filter((ip) => ip !== localIp);
        for (let i = 0; i < destinations.length; i += 32) {
          const batchResponses = await ssdpSearch(destinations.slice(i, i + 32), 1000);
          for (const [host, info] of batchResponses) responses.set(host, info);
          if (responses.size > 0) break;
        }

        // Some HiSilicon firmware does not answer SSDP M-SEARCH at all, but still
        // exposes the MultiScreen HTTP descriptor on 2015/8867. Probe those ports
        // as a final unicast fallback so discovery works on iOS without multicast entitlements.
        if (responses.size === 0) {
          for (const host of await probeHttpHosts(localIp, 450)) {
            responses.set(host, { server: "HiMultiScreenHTTP" });
          }
        }
      }
    } catch {
      // Keep any multicast results.
    }
  }

  return Promise.all(
    Array.from(responses.entries()).map(([host, info]) => resolveDevice(host, info.location, info.server)),
  );
}
