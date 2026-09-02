/**
 * Generic UPnP SOAP control-action client.
 *
 * The reference app's Action.postControlAction() (org.cybergarage.upnp) is a
 * standard UPnP SOAP-over-HTTP call: POST to the service's controlURL with a
 * SOAPACTION header of "<serviceType>#<actionName>" and a SOAP 1.1 envelope body.
 * This is not HiSilicon-specific — it's the UPnP DA spec — so a hand-rolled client
 * is both accurate and dependency-free.
 */

export type SoapArgs = Record<string, string | number | boolean>;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEnvelope(serviceType: string, actionName: string, args: SoapArgs): string {
  const argXml = Object.entries(args)
    .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`)
    .join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    "<s:Body>" +
    `<u:${actionName} xmlns:u="${serviceType}">${argXml}</u:${actionName}>` +
    "</u:" +
    actionName +
    ">" +
    "</s:Body></s:Envelope>"
  );
}

export type SoapResult = { ok: boolean; args: Record<string, string>; status?: number; error?: string };

function parseResponseArgs(xml: string): Record<string, string> {
  const args: Record<string, string> = {};
  const regex = /<([a-zA-Z0-9_]+)>([^<]*)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml))) {
    args[match[1]] = match[2];
  }
  return args;
}

/** Posts a UPnP control action and returns the parsed output arguments. */
export async function postSoapAction(
  controlUrl: string,
  serviceType: string,
  actionName: string,
  args: SoapArgs = {},
  timeoutMs = 4000,
): Promise<SoapResult> {
  const body = buildEnvelope(serviceType, actionName, args);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(controlUrl, {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        SOAPACTION: `"${serviceType}#${actionName}"`,
      },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, args: {}, status: response.status, error: text.slice(0, 200) };
    }
    return { ok: true, args: parseResponseArgs(text), status: response.status };
  } catch (error) {
    return { ok: false, args: {}, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Legacy UPnP DA 1.0 QueryStateVariable extension (deprecated in DA 1.1 but still
 * implemented by cybergarage-derived embedded stacks like this STB's). Used only as
 * a best-effort way to confirm the live Vinput port; VINPUT_DEFAULT_PORT (8822) is
 * the documented fallback if this fails or times out.
 */
export async function queryStateVariable(
  controlUrl: string,
  varName: string,
  timeoutMs = 2500,
): Promise<string | undefined> {
  const QUERY_SERVICE_TYPE = "urn:schemas-upnp-org:control-1-0";
  const result = await postSoapAction(
    controlUrl,
    QUERY_SERVICE_TYPE,
    "QueryStateVariable",
    { varName },
    timeoutMs,
  );
  return result.ok ? result.args.return : undefined;
}
