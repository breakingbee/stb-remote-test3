/**
 * Minimal, dependency-free XML helpers for parsing UPnP device-description documents.
 *
 * React Native has no built-in DOMParser, and pulling in a full XML library for a
 * handful of flat, well-formed UPnP tags is overkill. UPnP device/service descriptions
 * are simple non-nested-attribute XML, so a small tag-scoped regex extractor is safe
 * and matches what the reference app's SaxXmlUtil effectively does.
 */

/** Returns the text content of the first `<tag>...</tag>` match, if any. */
export function extractTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim();
}

/** Returns the raw inner XML of every top-level `<tag>...</tag>` block. */
export function extractBlocks(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) {
    blocks.push(match[1]);
  }
  return blocks;
}

export type UpnpServiceDescriptor = {
  serviceType: string;
  serviceId?: string;
  controlUrl: string;
  eventSubUrl?: string;
  scpdUrl?: string;
};

export type UpnpDeviceDescriptor = {
  friendlyName?: string;
  deviceType?: string;
  udn?: string;
  services: UpnpServiceDescriptor[];
};

function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

/** Parses a UPnP root device description XML document into a flat descriptor. */
export function parseDeviceDescription(xml: string, baseUrl: string): UpnpDeviceDescriptor {
  const deviceBlock = extractTag(xml, "device") ?? xml;
  const friendlyName = extractTag(deviceBlock, "friendlyName");
  const deviceType = extractTag(deviceBlock, "deviceType");
  const udn = extractTag(deviceBlock, "UDN");

  const services: UpnpServiceDescriptor[] = [];
  for (const block of extractBlocks(deviceBlock, "service")) {
    const serviceType = extractTag(block, "serviceType");
    const controlUrlRaw = extractTag(block, "controlURL");
    if (!serviceType || !controlUrlRaw) continue;
    services.push({
      serviceType,
      serviceId: extractTag(block, "serviceId"),
      controlUrl: resolveUrl(baseUrl, controlUrlRaw),
      eventSubUrl: (() => {
        const raw = extractTag(block, "eventSubURL");
        return raw ? resolveUrl(baseUrl, raw) : undefined;
      })(),
      scpdUrl: (() => {
        const raw = extractTag(block, "SCPDURL");
        return raw ? resolveUrl(baseUrl, raw) : undefined;
      })(),
    });
  }

  return { friendlyName, deviceType, udn, services };
}
