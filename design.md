# STB Remote — Mobile Interface Design

## Product direction

STB Remote is a native iPhone and iPad remote for HiSilicon-based set-top boxes. The primary interaction is one-handed portrait use on iPhone. The interface should feel like a focused first-party iOS utility: dark, calm, tactile, and immediately understandable without onboarding friction.

The app will support local-network device discovery, a compact remote control, a numeric/channel sheet, an optional screen-view surface, and settings for manually selecting a discovered STB. It will use the HiSilicon multiscreen protocol discovered in the reference APK: UPnP discovery for device/service metadata, UDP Vinput datagrams for button actions, and a separate mirror/screen-view flow.

## Screen list

| Screen | Primary content | Required functionality |
|---|---|---|
| Remote | Connection status, selected STB name/IP, directional pad, OK, Back, Home, Info, Guide, volume, channel, mute, media, and color actions | Discover/select a box, send key-down/key-up or tap actions, show delivery feedback, open numeric keypad and settings |
| Numeric Pad | Large digits, last entered channel, clear, enter/OK | Enter a channel number and send digits followed by OK; dismiss as a bottom sheet |
| Screen View | Live mirror surface, connection state, pause/stop control, orientation/fullscreen affordance | Start/stop the optional screen-view session through the multiscreen mirror service; clearly separate this from remote button transport |
| Devices & Connection | Discovered devices, selected device, IP address, Vinput service status, refresh control, manual IP fallback | Discover via local network, select a device, retry discovery, save a manual fallback endpoint locally |
| Settings | Haptics toggle, button repeat behavior, screen-view enablement, diagnostics | Configure local behavior and view protocol diagnostics without exposing packet payloads |
| About | App version, protocol scope, privacy statement | Explain that the app communicates only with a user-selected local STB and does not require an account |

## Home/Remote layout

The main Remote screen uses portrait orientation and thumb-friendly vertical zones. The top 96 points contain a compact connection card with a green/amber/gray status dot, STB display name, IP address, and a disclosure button for Devices & Connection. Below it, a segmented mode control switches between `Remote` and `Screen View` without hiding the connection state.

The remote body is organized into a thumb-reachable control stack. The primary circular D-pad sits in the upper-middle area, with Up, Down, Left, Right, and a larger centered OK button. Back and Home sit just below the pad. Info and Guide are placed as two medium-width buttons below the navigation cluster. Volume and Channel controls use two vertical pill groups on the left and right edges, with Mute centered between them. Media controls and color keys sit in a compact lower grid. The Numeric Pad opens as a bottom sheet so the main screen remains uncluttered.

The remote should not use tiny text-only controls. Each action has an SF Symbol-style icon and an accessible label. Color keys use restrained red, green, yellow, and blue accents with sufficient contrast rather than saturated full-button fills.

## Screen View layout

Screen View is a separate tab-like mode, not an overlay on the remote. When inactive, it shows a clear empty state explaining that the app will request the STB’s mirror service. When active, it uses an edge-to-edge dark surface with the video viewport centered, a small connection indicator, and a bottom control tray containing Stop, Reconnect, and Rotate/Fullscreen actions. A warning appears when the STB does not advertise the required mirror services.

The screen-view implementation should remain modular because the reference APK uses native HiSilicon mirror/video components and a callback parameter such as `cport=8888`; the initial app can ship discovery and protocol scaffolding before native H.264 reception is enabled.

## Key user flows

### First connection

1. User opens the app and sees `Looking for STBs on this Wi‑Fi…`.
2. The app performs local UPnP discovery.
3. A discovered device appears with its name, IP address, and Vinput availability.
4. User taps the device, which becomes the selected target.
5. The app returns to Remote and shows `Connected` or `Ready to send`.

### Send a button action

1. User taps a control such as Info.
2. The button gives immediate pressed-state feedback and light haptic feedback.
3. The app builds a protocol request with the selected key code and tap/down-up state.
4. The app sends the UDP datagram to the dynamically discovered Vinput service port.
5. The button briefly shows a sent-state indicator; errors appear in the connection card without interrupting the flow.

### Long press

1. User presses and holds a supported action such as volume or channel.
2. The app sends a key-down event after the configured threshold.
3. Repeat events are sent at a controlled interval while held.
4. On release, the app sends key-up and stops repeating.
5. If the connection drops, the app stops the repeat loop immediately.

### Channel entry

1. User taps the numeric keypad button.
2. A bottom sheet presents digits 0–9, Delete, Clear, and Enter.
3. Entered digits appear in a large readable display.
4. User taps Enter; the app sends the configured digit events followed by OK.
5. The sheet dismisses and returns focus to the Remote screen.

### Screen view

1. User switches to Screen View.
2. The app checks whether the selected device advertises mirror-control and mirror-data services.
3. User taps Start.
4. The app negotiates mirror parameters using the local device address and callback port.
5. The viewport shows connecting, active, paused, or unavailable states.
6. User taps Stop or leaves the mode; the app releases the session and returns to Remote.

## Visual language and colors

The brand should feel like a precise home-theater control surface rather than a generic smart-home app.

| Token | Light mode | Dark mode | Usage |
|---|---|---|---|
| Background | `#F4F7FA` | `#0B1118` | Screen background |
| Surface | `#FFFFFF` | `#131D28` | Cards and sheets |
| Elevated surface | `#EAF0F5` | `#1B2938` | D-pad wells and control groups |
| Foreground | `#12202C` | `#F5F8FB` | Primary text and icons |
| Muted | `#607181` | `#9AAABD` | Secondary labels |
| Brand primary | `#2D7FF9` | `#5B9BFF` | Selected states and connection actions |
| Brand deep | `#1555B8` | `#8BB8FF` | Pressed states and emphasis |
| Success | `#25B779` | `#48D597` | Connected/ready |
| Warning | `#D88A1D` | `#F5B84B` | Discovering/degraded |
| Error | `#C84B57` | `#FF7C86` | Failed/disconnected |
| Divider | `#D7E0E8` | `#273747` | Separators |
| Red key | `#D85A63` | `#F07A83` | Color key accent |
| Green key | `#32A978` | `#55D59F` | Color key accent |
| Yellow key | `#D6A62B` | `#F0C75E` | Color key accent |
| Blue key | `#3679D8` | `#6EA4FF` | Color key accent |

Use rounded rectangles with 16–22 point corner radii, 48–60 point minimum touch targets, subtle 1-point dividers, and restrained shadows only on elevated surfaces. Avoid dense gradients, excessive glass effects, and decorative animation.

## Accessibility and feedback

All controls must expose an accessibility label and role. The D-pad must support VoiceOver descriptions such as “Move up” and “Select.” Color buttons must include their color and action in the label. Focus and pressed states must remain visible without relying on color alone. Haptics are optional and disabled through Settings; network errors use text and status icons rather than vibration alone.

## Technical UI assumptions

The app is local-first and does not need user authentication, cloud storage, or a backend. Device selection and preferences are persisted with local storage. Discovery and UDP transport are isolated behind typed interfaces so the UI can be tested with deterministic mocks. The screen-view feature is isolated behind a capability check and must degrade gracefully if native video support is unavailable in the current Expo build.
