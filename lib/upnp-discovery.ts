import { Platform } from "react-native";

import { MULTISCREEN_DEVICE_TYPE, VINPUT_DEFAULT_PORT, VINPUT_SERVICE_TYPE, type StbDevice } from "@/lib/stb-protocol";
import { parseDeviceDescription } from "@/lib/xml-lite";

type Socket = {
  bind: (port?: number) => void;
  close: () => void;
  on: (event: "message", handler: (message: Uint8Array, remote: { address: string }) => void) => void;
  send: (message: Uint8Array, offset: number, length: number, port: number, host: string, callback?: (error?: Error) => void) => void;
};

type Dgram = { createSocket: (options: { type: "udp4" }) => Socket };

function loadDgram(): Dgram | null {
  if (Platform.OS === "web") return null;
  try {
    // react-native-udp is only present in a native development build (not Expo Go).
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

/**
 * Sends an SSDP M-SEARCH for HiMultiScreenServerDevice and turns every unicast reply
 * into a fully-resolved StbDevice by fetching and parsing that device's real
 * description XML (friendlyName, UDN, and every service's controlURL) — the previous
 * scaffold guessed at the Vinput port with a regex against the *description* document,
 * which never actually contains a live state-variable value. We now resolve the port
 * the same way the reference app does: via a UPnP action against VinputControlServer
 * (see lib/vinput-control.ts), falling back to the documented static port 8822.
 */
export async function discoverHiSiliconStbs(timeoutMs = 2500): Promise<StbDevice[]> {
  const dgram = loadDgram();
  if (!dgram) return [];

  const socket = dgram.createSocket({ type: "udp4" });
  const responses = new Map<string, { location?: string; server?: string }>();
  const request = new TextEncoder().encode(
    [
      "M-SEARCH * HTTP/1.1",
      "HOST: 239.255.255.250:1900",
      'MAN: "ssdp:discover"',
      "MX: 2",
      `ST: ${MULTISCREEN_DEVICE_TYPE}`,
      "",
      "",
    ].join("\r\n"),
  );

  return new Promise((resolve) => {
    let finished = false;
    const complete = async () => {
      if (finished) return;
      finished = true;
      socket.close();

      const devices: StbDevice[] = [];
      for (const [host, info] of responses) {
        let descriptionXml = "";
        if (info.location) {
          try {
            const response = await fetch(info.location);
            descriptionXml = await response.text();
          } catch {
            descriptionXml = "";
          }
        }

        if (!descriptionXml) {
          // Device answered SSDP but its description couldn't be fetched (offline,
          // wrong subnet, HTTP server not up yet). Still surface it with the static
          // Vinput port so a manual "connect anyway" is possible.
          devices.push({
            id: `${host}-fallback`,
            name: info.server?.split("/")[0] ?? "HiSilicon STB",
            host,
            vinput: { host, port: VINPUT_DEFAULT_PORT, serviceName: VINPUT_SERVICE_TYPE },
          });
          continue;
        }

        const parsed = parseDeviceDescription(descriptionXml, info.location!);
        const vinputService = parsed.services.find((s) => s.serviceType === VINPUT_SERVICE_TYPE);
        const accessService = parsed.services.find((s) => s.serviceType.includes("AccessControlServer"));
        const mirrorService = parsed.services.find((s) => s.serviceType.includes("MirrorControlServer"));

        devices.push({
          id: parsed.udn ?? `${host}-${vinputService ? "vinput" : "unknown"}`,
          name: parsed.friendlyName ?? info.server?.split("/")[0] ?? "HiSilicon STB",
          host,
          udn: parsed.udn,
          descriptionUrl: info.location,
          services: {
            access: accessService ? { controlUrl: accessService.controlUrl } : undefined,
            vinput: vinputService ? { controlUrl: vinputService.controlUrl } : undefined,
            mirror: mirrorService ? { controlUrl: mirrorService.controlUrl } : undefined,
          },
          // Port is resolved lazily (SOAP QueryStateVariable, else the static default)
          // by lib/vinput-control.ts right before the first packet is sent.
          vinput: { host, port: VINPUT_DEFAULT_PORT, serviceName: VINPUT_SERVICE_TYPE },
        });
      }
      resolve(devices);
    };

    socket.on("message", (message, remote) => {
      const text = decodeMessage(message);
      responses.set(remote.address, { location: header(text, "LOCATION"), server: header(text, "SERVER") });
    });
    socket.bind(0);
    socket.send(request, 0, request.length, 1900, "239.255.255.250");
    setTimeout(complete, timeoutMs);
  });
}
