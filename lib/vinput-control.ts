import { postSoapAction, queryStateVariable } from "@/lib/soap-client";
import { VINPUT_DEFAULT_PORT, VINPUT_SERVICE_TYPE, VINPUT_STATE_VARIABLE, type StbDevice, type VinputEndpoint } from "@/lib/stb-protocol";

/** VinputUpnpController.java */
export async function startVinput(device: StbDevice): Promise<boolean> {
  const controlUrl = device.services?.vinput?.controlUrl;
  if (!controlUrl) return false;
  const result = await postSoapAction(controlUrl, VINPUT_SERVICE_TYPE, "StartVinput");
  return result.ok;
}

export async function stopVinput(device: StbDevice): Promise<boolean> {
  const controlUrl = device.services?.vinput?.controlUrl;
  if (!controlUrl) return false;
  const result = await postSoapAction(controlUrl, VINPUT_SERVICE_TYPE, "StopVinput");
  return result.ok;
}

/**
 * Resolves the live Vinput UDP endpoint for a device: best-effort SOAP
 * QueryStateVariable first (matches HiDeviceInfo.addVinputService()), falling back
 * to the documented static port (MessageDef.VINPUT_PORT = 8822) which is what every
 * firmware build observed in the wild actually uses in practice.
 */
export async function resolveVinputEndpoint(device: StbDevice): Promise<VinputEndpoint> {
  const controlUrl = device.services?.vinput?.controlUrl;
  if (controlUrl) {
    const value = await queryStateVariable(controlUrl, VINPUT_STATE_VARIABLE);
    if (value) {
      const match = value.match(/:(\d+)(?:\/|$)/);
      const port = match ? Number(match[1]) : undefined;
      if (port) {
        return { host: device.host, port, serviceName: VINPUT_STATE_VARIABLE };
      }
    }
  }
  return { host: device.host, port: VINPUT_DEFAULT_PORT, serviceName: VINPUT_STATE_VARIABLE };
}
