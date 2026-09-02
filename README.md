# STB Remote (iOS)

An iOS remote control for HiSilicon-based set-top boxes ("AirSync"/multiscreen
protocol), built with Expo/React Native. Ported and completed from a partial
scaffold by reverse-engineering the reference Android app (`Air_Sync_Remote`) and
its STB-side counterpart (`MultiScreenServer.apk`).

## What works

- **Device discovery** — SSDP scan for `HiMultiScreenServerDevice`, real UPnP device
  description parsing (not guesswork).
- **Pairing** — SOAP `Hello`/`Ping`/`Byebye` handshake against `AccessControlServer`.
- **Remote control** — full keyboard (D-pad, OK/Back/Home, digits, colour keys, media
  transport), a drag-to-move trackpad (mouse), and multi-touch, all sent as
  byte-exact UDP packets to the STB's `VinputControlServer` (port 8822). Every packet
  layout is covered by tests in `tests/stb-protocol.test.ts`.
- **Screen View** — the mirror-session SOAP handshake works; live video decode does
  not (see below and `PROTOCOL.md` §4/§6 for why, in detail).

See [`PROTOCOL.md`](./PROTOCOL.md) for the full reverse-engineering writeup —
byte layouts, confidence levels, what's confirmed vs. not — and
[`BUILD.md`](./BUILD.md) for how to actually produce a `.ipa`.

## Project layout

```
lib/
  stb-protocol.ts     Wire-format packet builders (keyboard/mouse/touch), key codes
  vinput-transport.ts UDP transport wrapping the protocol builders
  upnp-discovery.ts   SSDP discovery + device description parsing
  xml-lite.ts         Minimal UPnP XML parsing helpers
  soap-client.ts       Generic UPnP SOAP action client
  access-control.ts   Hello/Ping/Byebye pairing handshake
  vinput-control.ts   StartVinput/StopVinput + port resolution
  mirror-control.ts   Mirror session handshake (control only, see caveats)
app/(tabs)/index.tsx  Remote / Trackpad / Screen View UI
tests/                Protocol unit tests (vitest)
```

## Quick start

```bash
npm install
npx expo start          # UI only — react-native-udp needs a native build to send real packets
npx vitest run          # protocol tests
npx tsc --noEmit        # typecheck
```

For a real device build (native UDP, actual STB control), see `BUILD.md`.

## Status / future work

- **Screen mirroring (live video) is not implemented.** The STB's video codec is
  compiled into a proprietary native library (Huawei "HME"), not present in any
  application code available for reverse engineering. Full detail and the one
  remaining lever (pulling the STB's own `libmultiscreendevice.so` for ARM binary RE)
  is documented in `PROTOCOL.md` §4 and §6.
- Everything else — discovery, pairing, keyboard, mouse, touch — is complete and
  tested.
