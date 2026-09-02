# HiSilicon AirSync multiscreen protocol — reverse-engineering notes

Source: `Air_Sync_Remote-Z_Beta_9_APKPure.apk` (package `com.aloys.formuler.airsyncremote`,
built on `com.hisilicon.multiscreen`), decompiled with jadx 1.5.5. This document
records exactly what was found and how confident each part is, so future edits don't
have to re-derive it.

## 1. Discovery — SSDP (100% confirmed)

Standard SSDP, no surprises:

- Multicast M-SEARCH to `239.255.255.250:1900`
- `ST: urn:schemas-upnp-org:device:HiMultiScreenServerDevice:1`
- The app's own control point binds its *local* listening socket to port 8009 instead
  of the SSDP default (8008) — `MultiScreenUpnpControlPoint()` calls
  `setSSDPPort(8009)` — but this only affects which local port *the Android app*
  listens on for unicast replies. The multicast target is untouched
  (`ControlPoint.java` hardcodes `HOST: 239.255.255.250:1900` in the SSDP request
  builder), so a fresh client (this iOS app) just needs a normal SSDP M-SEARCH from
  any local port. Implemented in `lib/upnp-discovery.ts`.
- Each device reply's `LOCATION` header points to a standard UPnP device description
  XML. `lib/xml-lite.ts` parses `friendlyName`, `UDN`, and every `<service>` block's
  `serviceType` / `controlURL`.

## 2. Pairing — AccessControlServer (confirmed from `AccessUpnpController.java`)

Before the STB will act on Vinput packets, the reference app performs a SOAP `Hello`
action against the `AccessControlServer` service:

- Args: `RemoteID` (the phone's WiFi MAC address — see caveat below), `RemoteIP`,
  `Version` ("3.0.1.0"), `DeviceInfo` (device model string), `SDKVersion`.
- The STB echoes `CurrentRemoteID`; success = it matches what was sent.
- A `Ping` action (with `RemoteID` + `PingTime`) is expected roughly every 1.5s to
  keep the pairing alive; `Byebye` on disconnect.
- **iOS caveat**: Apple has not exposed the real WiFi MAC address to third-party apps
  since iOS 7 (always returns a placeholder). The STB only ever compares `RemoteID`
  for string equality — it never validates it against real hardware — so
  `lib/access-control.ts` generates and persists a random, IEEE-802
  "locally administered" MAC-shaped string (`02:xx:xx:xx:xx:xx`) once per install.
  This is a legitimate substitute, not a workaround for anything the STB checks.
- Implemented in `lib/access-control.ts`.

## 3. Remote input — VinputControlServer (100% confirmed, byte-exact)

This is the core ask and the part with zero ambiguity — every byte was cross-checked
against `MSGHeadObject.java`, `KeyboardRequest.java`, `MouseRequest.java`,
`TouchRequest.java`, `MessageDef.java`, and `UDPClient.java`. See the doc comment at
the top of `lib/stb-protocol.ts` for the full byte layout; short version:

- Plain UDP, fire-and-forget, no ACK, no encryption.
- Fixed port **8822** (`MessageDef.VINPUT_PORT`). The reference app also has a path
  to resolve this dynamically via a legacy UPnP `QueryStateVariable` SOAP call
  against the state variable `HI_UPNP_VAR_VinpuServerURI` — `lib/vinput-control.ts`
  attempts that first and falls back to 8822, matching `HiDeviceInfo.addVinputService()`.
- 12-byte header on every packet: `sndModuleName(1) / rcvModuleName(2) / msgType /
  msgLen / reserved / reserved`, **all fields little-endian**.
- Keyboard (msgType 2, 22 bytes): header + `0x0107` marker + `u32 keyCode` +
  `u32 state (0=up, 1=down)`.
- Mouse (msgType 3, 22 bytes): header + `u16 clickType` + `i32 dx` + `i32 dy` (deltas
  are floats in Java but truncated to ints before being written to the wire).
- Touch (msgType 4, 76 bytes): header + `u32 fingerCount` + 5 × `(i32 x, i32 y, u32
  pressed)`, unused slots zero-filled.
- Key codes are **not** Android key codes — they're the STB's own Linux input-event
  codes (`KeyInfo.java`). The full table is reproduced in `KeyCode` in
  `lib/stb-protocol.ts`.
- Letters and punctuation are sent as a synthetic Shift+key chord
  (`RemoteKeyboard.sendDownAndUpKeyCode`'s big switch statement) — reproduced as
  `SHIFTED_KEY_MAP` / `isShiftedKey()` / `resolveShiftedKey()`.
- Mouse click-type constants (`RemoteMouse.java`) and the ±10 wheel-delta convention
  are reproduced as `MouseClickType`.

All of the above is covered by `tests/stb-protocol.test.ts` (byte-for-byte assertions
on packet layout, not just "did it run").

## 4. Screen mirroring — where the trail goes cold

`MirrorUpnpController.java` gives a clean, fully-implementable SOAP control channel
(`SetMirrorParameter` / `StartMirror` / `StopMirror`) — see `lib/mirror-control.ts`.

The video itself is a different story. `MirrorView.java` hands off every real piece of
work — `Init`, `SetLocalReceiver`, `SetSendDestination`, `SetReceiveCodec`,
`StartReceive`, `SetSendCodec`, `StartSend` — to `native` methods on
`com.huawei.videoengineapp.ViEAndroidJavaAPI`, which is a thin JNI wrapper with **no
protocol logic in Dex bytecode at all**. The actual encode/decode/packetization
(H.264, FEC via `eAntiPktLoss`, optional encryption via `eCipherType`, default UDP
port 11111 both directions, ~256kbps/320x240/15fps defaults) is compiled into
`libHME-Video.so` / `libHME_VideoEngine_jni.so` — ARMv7 shared objects for Android.
The class names and method signature are a close match to the old public WebRTC
Android `ViEAndroidJavaAPI` demo, suggesting Huawei's "HME" engine is a fork of it,
but that's a lead for further binary reverse engineering, not something decompiling
the APK's Dex bytecode can resolve — and even a full disassembly of those `.so` files
would produce Android ELF binaries, not iOS-portable code.

**What this app does instead**: sends the real control-channel SOAP calls so the STB
opens (and can be told to close) a mirror session, and is explicit in the UI
(`getMirrorCapability()`) that live video decode is not implemented and why, rather
than faking a decoder that would never receive decodable frames.

If real screen mirroring becomes a hard requirement, the realistic paths are (a) a
from-scratch ARM binary RE project on the two `.so` files (large, separate effort), or
(b) checking whether this STB also exposes a standard stream (RTSP/HLS) alongside the
proprietary mirror path — worth checking against the box's existing timeshift/HLS
tooling rather than this protocol.

## 5. Cross-check against the STB-side server (`MultiScreenServer.apk`)

Decompiling the actual server component pulled off the STB confirmed everything above
with zero contradictions: `UpnpMultiScreenDeviceInfo.java` on the server defines the
exact same service type strings and state-variable name used in `lib/stb-protocol.ts`
(`MirrorControlServer:1`, `VinputControlServer:1`, `HI_UPNP_VAR_VinpuServerURI`) —
verified from both the client and server side now, not just inferred from the client.

It also confirms the mirror dead-end from a second angle: `MultiScreenNative.java`
shows the *entire* server-side implementation — Vinput handling, Mirror capture and
encode, everything — is one `System.loadLibrary("multiscreendevice")` call. This
`.so` isn't bundled in the server APK at all; it's a system-level library that's
assumed to already be present in the STB's firmware (`/system/lib`). There is
genuinely nothing left to decompile from any APK — client or server — for the mirror
video path.

## 6. Future work — screen mirroring

Not implemented, and not realistically recoverable from any APK. If this becomes
worth pursuing later, the one real lever is pulling `libmultiscreendevice.so` directly
off the STB's own filesystem (`/system/lib`) — since it's the actual binary doing the
work, rather than a wrapper around it — and disassembling it with something like
Ghidra. That's a standalone ARM reverse-engineering project, independent of this repo,
with no guarantee of a clean result. The control-channel handshake
(`lib/mirror-control.ts`) is ready to pair with a real decoder if one is ever built.
