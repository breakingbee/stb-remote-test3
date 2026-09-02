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

type Dgram = {
  createSocket: (options: { type: "udp4" }) => Socket;
};

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

async function resolveDevice(
  host: string,
  location?: string,
  server?: string,
): Promise<StbDevice> {
  let descriptionXml = "";

  if (location) {
    try {
      const response = await fetch(location);
      if (response.ok) {
        descriptionXml = await response.text();
      }
    } catch {
      // Keep fallback below.
    }
  }

  if (!descriptionXml) {
    return {
      id: `${host}-fallback`,
      name: server?.split("/")[0] ?? "HiSilicon STB",
      host,
      vinput: {
        host,
        port: VINPUT_DEFAULT_PORT,
        serviceName: VINPUT_SERVICE_TYPE,
      },
    };
  }

  const parsed = parseDeviceDescription(
    descriptionXml,
    location ?? `http://${host}/`,
  );

  const vinputService = parsed.services.find(
    (service) => service.serviceType === VINPUT_SERVICE_TYPE,
  );

  const accessService = parsed.services.find((service) =>
    service.serviceType.includes("AccessControlServer"),
  );

  const mirrorService = parsed.services.find((service) =>
    service.serviceType.includes("MirrorControlServer"),
  );

  return {
    id: parsed.udn ?? `${host}-${vinputService ? "vinput" : "unknown"}`,
    name: parsed.friendlyName ?? server?.split("/")[0] ?? "HiSilicon STB",
    host,
    udn: parsed.udn,
    descriptionUrl: location,
    services: {
      access: accessService
        ? { controlUrl: accessService.controlUrl }
        : undefined,
      vinput: vinputService
        ? { controlUrl: vinputService.controlUrl }
        : undefined,
      mirror: mirrorService
        ? { controlUrl: mirrorService.controlUrl }
        : undefined,
    },
    vinput: {
      host,
      port: VINPUT_DEFAULT_PORT,
      serviceName: VINPUT_SERVICE_TYPE,
    },
  };
}

async function ssdpSearch(
  destinations: string[],
  timeoutMs: number,
): Promise<Map<string, { location?: string; server?: string }>> {
  const dgram = loadDgram();
  if (!dgram) return new Map();

  const socket = dgram.createSocket({ type: "udp4" });
  const responses = new Map<string, { location?: string; server?: string }>();
  const request = buildSearchRequest();

  return new Promise((resolve) => {
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch {
        // Ignore close errors.
      }
      resolve(responses);
    };

    socket.on("message", (message, remote) => {
      const text = decodeMessage(message);
      const host = normalizeHost(remote.address);

      responses.set(host, {
        location: header(text, "LOCATION"),
        server: header(text, "SERVER"),
      });
    });

    // IMPORTANT: wait for bind before sending. The previous implementation
    // could call send() before react-native-udp had finished binding.
    socket.bind(0, "0.0.0.0", () => {
      for (const destination of destinations) {
        socket.send(
          request,
          0,
          request.length,
          1900,
          destination,
          () => {
            // Ignore individual UDP send errors and continue discovery.
          },
        );
      }
    });

    setTimeout(finish, timeoutMs);
  });
}

/**
 * Discover HiSilicon MultiScreen STBs.
 *
 * First uses standard SSDP multicast. If iOS multicast is unavailable,
 * falls back to unicast M-SEARCH probes across the local IPv4 /24.
 */
export async function discoverHiSiliconStbs(
  timeoutMs = 2500,
): Promise<StbDevice[]> {
  const multicastResponses = await ssdpSearch(
    ["239.255.255.250"],
    timeoutMs,
  );

  const responses = new Map(multicastResponses);

  // Multicast may be unavailable on a free-signed iOS app. Use ordinary
  // unicast UDP as a fallback, which does not require the multicast entitlement.
  if (responses.size === 0) {
    try {
      const localIp = await Network.getIpAddressAsync();

      if (localIp && /^\d+\.\d+\.\d+\.\d+$/.test(localIp)) {
        const parts = localIp.split(".");
        const prefix = parts.slice(0, 3).join(".");

        const destinations = Array.from(
          { length: 254 },
          (_, index) => `${prefix}.${index + 1}`,
        ).filter((ip) => ip !== localIp);

        // Probe in batches so discovery doesn't create hundreds of sockets.
        for (let i = 0; i < destinations.length; i += 32) {
          const batch = destinations.slice(i, i + 32);
          const batchResponses = await ssdpSearch(batch, 1000);

          for (const [host, info] of batchResponses) {
            responses.set(host, info);
          }

          if (responses.size > 0) break;
        }
      }
    } catch {
      // Keep multicast results, if any.
    }
  }

  const devices = await Promise.all(
    Array.from(responses.entries()).map(([host, info]) =>
      resolveDevice(host, info.location, info.server),
    ),
  );

  return devices;
}
