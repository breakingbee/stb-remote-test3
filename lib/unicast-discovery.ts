import * as Network from "expo-network";

import {
  ACCESS_SERVICE_TYPE,
  MIRROR_SERVICE_TYPE,
  VINPUT_DEFAULT_PORT,
  VINPUT_SERVICE_TYPE,
  VINPUT_STATE_VARIABLE,
  type StbDevice,
} from "@/lib/stb-protocol";
import { parseDeviceDescription } from "@/lib/xml-lite";

/**
 * Unicast-only STB discovery — no SSDP, no multicast, no broadcast.
 *
 * Uses direct HTTP probes against the HiSilicon UPnP device-description endpoint.
 * This is intended as the free/unsigned iOS path where multicast discovery may be unavailable.
 */

const KNOWN_DESCRIPTION_PORT = 49152;
const FALLBACK_PORT_RANGE = { start: 49152, end: 49170 };
const DESCRIPTION_PATH = "/description.xml";

function candidatePorts(): number[] {
  const ports = [KNOWN_DESCRIPTION_PORT];
  for (let port = FALLBACK_PORT_RANGE.start; port <= FALLBACK_PORT_RANGE.end; port++) {
    if (port !== KNOWN_DESCRIPTION_PORT) ports.push(port);
  }
  return ports;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function deviceFromDescriptionXml(xml: string, host: string, descriptionUrl: string): StbDevice | null {
  if (!xml.includes("HiMultiScreenServerDevice")) return null;
  const parsed = parseDeviceDescription(xml, descriptionUrl);
  const vinputService = parsed.services.find((s) => s.serviceType === VINPUT_SERVICE_TYPE);
  const accessService = parsed.services.find((s) => s.serviceType === ACCESS_SERVICE_TYPE);
  const mirrorService = parsed.services.find((s) => s.serviceType === MIRROR_SERVICE_TYPE);

  return {
    id: parsed.udn ?? `${host}-unicast`,
    name: parsed.friendlyName ?? "HiSilicon STB",
    host,
    udn: parsed.udn,
    descriptionUrl,
    services: {
      access: accessService ? { controlUrl: accessService.controlUrl } : undefined,
      vinput: vinputService ? { controlUrl: vinputService.controlUrl } : undefined,
      mirror: mirrorService ? { controlUrl: mirrorService.controlUrl } : undefined,
    },
    vinput: { host, port: VINPUT_DEFAULT_PORT, serviceName: VINPUT_STATE_VARIABLE },
  };
}

export async function probeStbAtHost(host: string, timeoutMs = 1200): Promise<StbDevice | null> {
  for (const port of candidatePorts()) {
    const url = `http://${host}:${port}${DESCRIPTION_PATH}`;
    const xml = await fetchWithTimeout(url, timeoutMs);
    if (xml) {
      const device = deviceFromDescriptionXml(xml, host, url);
      if (device) return device;
    }
  }
  return null;
}

function hostsInSubnet(localIp: string): string[] {
  const parts = localIp.split(".");
  if (parts.length !== 4) return [];
  const prefix = parts.slice(0, 3).join(".");
  return Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export type SubnetScanProgress = { checked: number; total: number };

export async function scanSubnetForStbs(onProgress?: (progress: SubnetScanProgress) => void): Promise<StbDevice[]> {
  const localIp = await Network.getIpAddressAsync().catch(() => null);
  if (!localIp) return [];

  const hosts = hostsInSubnet(localIp);
  let checked = 0;
  const found = await mapWithConcurrency(hosts, 24, async (host) => {
    const url = `http://${host}:${KNOWN_DESCRIPTION_PORT}${DESCRIPTION_PATH}`;
    const xml = await fetchWithTimeout(url, 800);
    checked++;
    onProgress?.({ checked, total: hosts.length });
    return xml ? deviceFromDescriptionXml(xml, host, url) : null;
  });

  return found.filter((device): device is StbDevice => device !== null);
}
