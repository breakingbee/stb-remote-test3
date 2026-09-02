import { postSoapAction } from "@/lib/soap-client";
import { MIRROR_SERVICE_TYPE, type StbDevice } from "@/lib/stb-protocol";

/**
 * Screen-mirror control channel — MirrorUpnpController.java / MirrorView.java.
 *
 * What IS reverse engineered and implemented here: the SOAP control handshake
 * (SetMirrorParameter / StartMirror / StopMirror) that tells the STB to open its
 * mirroring session and negotiate parameters.
 *
 * What is NOT (and, realistically, cannot be from this APK): the video itself.
 * MirrorView routes every actual media call — Init, SetLocalReceiver,
 * SetSendDestination, SetReceiveCodec, StartReceive, SetSendCodec, StartSend — through
 * `native` JNI methods implemented in libHME-Video.so / libHME_VideoEngine_jni.so
 * (Huawei's "HME" video engine, a fork of the old public WebRTC Android VideoEngine
 * demo). None of that packetization, encryption (`eCipherType`), or FEC
 * (`eAntiPktLoss`) logic exists anywhere in the decompiled Java/Dex bytecode — it is
 * entirely inside compiled ARMv7 machine code. Recovering the exact wire format would
 * require disassembling those .so files (a large, separate binary reverse-engineering
 * project), and even a full disassembly wouldn't produce anything runnable on iOS:
 * they are Android ELF shared objects built for a completely different ABI/OS, not
 * portable source.
 *
 * The defaults below (H.264, 320x240, ~256kbps, UDP port 11111 both directions) are
 * real — they're the static fields the Java layer initializes before handing off to
 * native code (see ViEAndroidJavaAPI) — but sending them alone will not produce a
 * decodable stream on this app. `capability.videoDecodeAvailable` is false for exactly
 * this reason; the UI should show a clear "mirroring session requested, live video not
 * supported" state rather than pretending to render frames that never arrive decoded.
 */

export const MIRROR_DEFAULTS = {
  codec: "h264",
  width: 320,
  height: 240,
  frameRateFps: 15,
  bitRateKbps: 256,
  udpPort: 11111,
} as const;

export type MirrorCapability = {
  controlAvailable: boolean;
  videoDecodeAvailable: false;
  reason: string;
};

export function getMirrorCapability(device: StbDevice): MirrorCapability {
  return {
    controlAvailable: Boolean(device.services?.mirror?.controlUrl),
    videoDecodeAvailable: false,
    reason:
      "The STB's screen-mirror video codec is implemented in a proprietary compiled " +
      "native library (Huawei HME), not in application code, so it can't be replicated " +
      "in this app. Remote-control (keyboard/mouse/touch) is fully implemented and does " +
      "not depend on this.",
  };
}

/** MirrorUpnpController.setMirrorParameter() */
export async function setMirrorParameter(device: StbDevice, remoteId: string, parameter: string) {
  const controlUrl = device.services?.mirror?.controlUrl;
  if (!controlUrl) return { ok: false as const };
  const result = await postSoapAction(controlUrl, MIRROR_SERVICE_TYPE, "SetMirrorParameter", {
    RemoteID: remoteId,
    MirrorParameter: parameter,
  });
  return { ok: result.ok };
}

/** MirrorUpnpController.startMirror() — opens the session; does not render video. */
export async function startMirror(device: StbDevice) {
  const controlUrl = device.services?.mirror?.controlUrl;
  if (!controlUrl) return { ok: false as const };
  const result = await postSoapAction(controlUrl, MIRROR_SERVICE_TYPE, "StartMirror");
  return { ok: result.ok };
}

/** MirrorUpnpController.stopMirror() */
export async function stopMirror(device: StbDevice) {
  const controlUrl = device.services?.mirror?.controlUrl;
  if (!controlUrl) return { ok: false as const };
  const result = await postSoapAction(controlUrl, MIRROR_SERVICE_TYPE, "StopMirror");
  return { ok: result.ok };
}
