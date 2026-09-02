# Project TODO

- [x] Define typed STB device, UPnP service, Vinput endpoint, and mirror capability models
- [x] Implement local UPnP discovery for HiSilicon multiscreen devices
- [x] Implement Vinput UDP request serialization and send key down/up actions
- [x] Add reliable connection state, timeout, retry, and manual IP fallback
- [x] Build one-handed iOS Remote screen with navigation, volume, channel, media, Info, Guide, and color controls
- [x] Add numeric channel-entry bottom sheet
- [x] Add long-press repeat behavior with release cancellation
- [x] Add Devices & Connection screen with persisted local selection
- [x] Add Settings screen for haptics, repeat behavior, and diagnostics
- [x] Add Screen View capability check and mirror-session foundation
- [x] Implement deterministic protocol mocks and unit tests
- [x] Generate and configure the custom STB Remote app icon
- [x] Verify iOS, Android, and web-safe rendering where applicable
- [x] Run typecheck, lint, and tests
- [x] Capture responsive previews and save a final checkpoint

- [ ] Add a native development-build workflow for react-native-udp; Expo Go cannot exercise the UDP module
- [ ] Make UPnP discovery work in a native build and show the discovered Vinput UDP port
- [ ] Add a manual endpoint mode that accepts both STB IP and Vinput UDP port
- [ ] Add a connection test with clear diagnostics for local-network permission, discovery, and UDP send status
- [ ] Document that the current Expo Go preview is UI/protocol preview only until a native build is installed
