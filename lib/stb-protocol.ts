/**
 * HiSilicon "AirSync" multi-screen protocol — clean-room TypeScript re-implementation.
 *
 * Reverse engineered from Air_Sync_Remote (Formuler "AirSync Remote"), which is built
 * on HiSilicon's com.hisilicon.multiscreen SDK. Every constant below was cross-checked
 * against the decompiled MessageDef, MSGHeadObject, KeyboardRequest, MouseRequest,
 * TouchRequest and KeyInfo classes — this is not guesswork.
 *
 * Wire format summary
 * --------------------
 * Every VINPUT packet is a fixed-size, little-endian UDP datagram sent to the STB's
 * VinputControlServer UDP port (fixed at 8822, see MessageDef.VINPUT_PORT). There is
 * no response — this is fire-and-forget, exactly like sending raw Linux input events.
 *
 * All packets share a 12-byte header (MSGHeadObject):
 *   offset 0  (u16) sndModuleName   -> always 1  (MTSC_MODULE_RC_APP, "we are the remote app")
 *   offset 2  (u16) rcvModuleName   -> always 2  (MTSC_MODULE_RC_CENTER, "STB input driver")
 *   offset 4  (u16) msgType         -> 2 = keyboard, 3 = mouse, 4 = touch
 *   offset 6  (u16) msgLen          -> total packet length in bytes
 *   offset 8  (u16) rsv             -> 0
 *   offset 10 (u16) rsvTwo          -> 0
 *
 * IMPORTANT: every field in this protocol is little-endian on the wire. The original
 * Java source writes big-endian ByteBuffers but reverses every short/int with
 * Short.reverseBytes()/Integer.reverseBytes() before writing, which nets out to
 * little-endian bytes on the wire. DataView's `littleEndian = true` reproduces this
 * directly, which is what every builder below uses.
 *
 * Keyboard packet (22 bytes total) — KeyboardRequest.java:
 *   [12-byte header][u16 marker=0x0107][u32 keyCode][u32 state(0=up,1=down)]
 *
 * Mouse packet (22 bytes total) — MouseRequest.java:
 *   [12-byte header][u16 clickType][i32 dx (float truncated to int!)][i32 dy]
 *
 * Touch packet (76 bytes total) — TouchRequest.java:
 *   [12-byte header][u32 fingerCount][5 x (i32 x, i32 y, u32 pressed)]
 *   (unused finger slots are zero-filled; the reference app always reserves 5 slots)
 */

// ---------------------------------------------------------------------------
// Header / message-type constants (MessageDef.java)
// ---------------------------------------------------------------------------

export const MTSC_MODULE_RC_APP = 1; // sender: the remote-control phone app
export const MTSC_MODULE_RC_CENTER = 2; // receiver: the STB's input driver

export const MTSC_MSGTYPE_KEYBOARD = 2;
export const MTSC_MSGTYPE_MOUSE = 3;
export const MTSC_MSGTYPE_TOUCH = 4;

/** Fixed-size marker written right after the header in every keyboard packet. */
const KEYBOARD_EVENT_MARKER = 0x0107;

/** Fixed UDP port the STB's Vinput driver listens on (MessageDef.VINPUT_PORT). */
export const VINPUT_DEFAULT_PORT = 8822;

/** Well-known UPnP service/state-variable names used to (re)discover that port. */
export const VINPUT_SERVICE_TYPE = "urn:schemas-upnp-org:service:VinputControlServer:1";
export const VINPUT_STATE_VARIABLE = "HI_UPNP_VAR_VinpuServerURI";

export const ACCESS_SERVICE_TYPE = "urn:schemas-upnp-org:service:AccessControlServer:1";
export const MIRROR_SERVICE_TYPE = "urn:schemas-upnp-org:service:MirrorControlServer:1";

export const MULTISCREEN_DEVICE_TYPE = "urn:schemas-upnp-org:device:HiMultiScreenServerDevice:1";

export const CLIENT_VERSION = "3.0.1.0";

// ---------------------------------------------------------------------------
// Header writer
// ---------------------------------------------------------------------------

function writeHeader(view: DataView, msgType: number, msgLen: number) {
  view.setUint16(0, MTSC_MODULE_RC_APP, true);
  view.setUint16(2, MTSC_MODULE_RC_CENTER, true);
  view.setUint16(4, msgType, true);
  view.setUint16(6, msgLen, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export const KEY_STATE_UP = 0;
export const KEY_STATE_DOWN = 1;

/** Builds a single 22-byte KeyboardRequest packet (KeyboardRequest.getBytes()). */
export function buildKeyboardRequest(keyCode: number, state: 0 | 1): Uint8Array {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  writeHeader(view, MTSC_MSGTYPE_KEYBOARD, 22);
  view.setUint16(12, KEYBOARD_EVENT_MARKER, true);
  view.setUint32(14, keyCode >>> 0, true);
  view.setUint32(18, state >>> 0, true);
  return bytes;
}

// ---------------------------------------------------------------------------
// Mouse (RemoteMouse.java click-type constants)
// ---------------------------------------------------------------------------

export const MouseClickType = {
  MOVE: 256,
  RIGHT_SINGLE_CLICK: 513,
  RIGHT_DOUBLE_CLICK: 514,
  RIGHT_DOWN: 515,
  RIGHT_UP: 516,
  RIGHT_DOWN_MOVE: 517,
  LEFT_SINGLE_CLICK: 769, // the reference app intercepts this and sends KEYCODE_BACK instead
  LEFT_DOUBLE_CLICK: 770,
  LEFT_DOWN: 771,
  LEFT_UP: 772,
  LEFT_DOWN_MOVE: 773,
  WHEEL: 774,
} as const;

export const MOUSE_WHEEL_DOWN_DELTA = -10;
export const MOUSE_WHEEL_UP_DELTA = 10;

/** Builds a single 22-byte MouseRequest packet (MouseRequest.getBytes()). */
export function buildMouseRequest(clickType: number, dx: number, dy: number): Uint8Array {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  writeHeader(view, MTSC_MSGTYPE_MOUSE, 22);
  view.setUint16(12, clickType, true);
  // The reference implementation truncates the float deltas to ints before sending.
  view.setInt32(14, Math.trunc(dx), true);
  view.setInt32(18, Math.trunc(dy), true);
  return bytes;
}

// ---------------------------------------------------------------------------
// Touch (TouchRequest.java, up to 5 simultaneous fingers)
// ---------------------------------------------------------------------------

export const MAX_TOUCH_FINGERS = 5;

export type TouchFinger = { x: number; y: number; pressed: boolean };

/** Builds a single 76-byte TouchRequest packet (TouchRequest.getBytes()). */
export function buildTouchRequest(fingers: TouchFinger[]): Uint8Array {
  const bytes = new Uint8Array(76);
  const view = new DataView(bytes.buffer);
  writeHeader(view, MTSC_MSGTYPE_TOUCH, 76);
  const count = Math.min(fingers.length, MAX_TOUCH_FINGERS);
  view.setUint32(12, count, true);
  let offset = 16;
  for (let i = 0; i < MAX_TOUCH_FINGERS; i++) {
    const finger = fingers[i];
    if (finger) {
      view.setInt32(offset, Math.trunc(finger.x), true);
      view.setInt32(offset + 4, Math.trunc(finger.y), true);
      view.setUint32(offset + 8, finger.pressed ? 1 : 0, true);
    } else {
      view.setInt32(offset, 0, true);
      view.setInt32(offset + 4, 0, true);
      view.setUint32(offset + 8, 0, true);
    }
    offset += 12;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Key codes (KeyInfo.java — the STB's Linux input-event keycodes, NOT Android's)
// ---------------------------------------------------------------------------

export const KeyCode = {
  UNKNOWN: 0,
  DIGIT_1: 2,
  DIGIT_2: 3,
  DIGIT_3: 4,
  DIGIT_4: 5,
  DIGIT_5: 6,
  DIGIT_6: 7,
  DIGIT_7: 8,
  DIGIT_8: 9,
  DIGIT_9: 10,
  DIGIT_0: 11,
  MINUS: 12,
  EQUALS: 13,
  DEL: 14,
  TAB: 15,
  q: 16,
  w: 17,
  e: 18,
  r: 19,
  t: 20,
  y: 21,
  u: 22,
  i: 23,
  o: 24,
  p: 25,
  LEFT_BRACKET: 26,
  RIGHT_BRACKET: 27,
  ENTER: 28,
  a: 30,
  s: 31,
  d: 32,
  f: 33,
  g: 34,
  h: 35,
  j: 36,
  k: 37,
  l: 38,
  SEMICOLON: 39,
  APOSTROPHE: 40,
  GRAVE: 41,
  SHIFT_LEFT: 42,
  BACKSLASH: 43,
  z: 44,
  x: 45,
  c: 46,
  v: 47,
  b: 48,
  n: 49,
  m: 50,
  COMMA: 51,
  DOT: 52,
  SLASH: 53,
  SHIFT_RIGHT: 54,
  SPACE: 57,
  F12: 88,
  DPAD_UP: 103,
  DPAD_LEFT: 105,
  DPAD_RIGHT: 106,
  HOME: 102,
  DPAD_DOWN: 108,
  NEXT: 109,
  PREVIOUS: 104,
  MENU: 139,
  SCALE_RIGHT: 159,
  BACK: 158,
  STOP: 128,
  SCALE_LEFT: 168,
  MUTE: 113,
  VOLUME_DOWN: 114,
  VOLUME_UP: 115,
  POWER: 116,
  PLAY: 164,
  RED: 60,
  GREEN: 59,
  YELLOW: 61,
  BLUE: 62,
  CH_INC: 402,
  CH_DEC: 403,
  INFO: 358,
  SEARCH: 217,
  ASK: 120,
} as const;

/**
 * Uppercase-letter and symbol key codes (KeyInfo.KEYCODE_A.._Z / punctuation) are sent
 * as a synthetic Shift+key chord. RemoteKeyboard.sendDownAndUpKeyCode() does this by
 * remapping the "shifted" keycode to its base key and wrapping it in a SHIFT_LEFT
 * down/up pair — see sendShiftedKey() below, which reproduces that table exactly.
 */
const SHIFTED_KEY_MAP: Record<number, number> = {
  78: 13, // KEYCODE_ADD -> '='
  120: 53, // KEYCODE_ASK -> '/'
  216: 16, // Q
  218: 18, // E
  219: 19, // R
  220: 20, // T
  221: 21, // Y
  222: 22, // U
  223: 23, // I
  224: 24, // O
  225: 25, // P
  230: 30, // A
  231: 31, // S
  232: 32, // D
  233: 33, // F
  234: 34, // G
  235: 35, // H
  236: 36, // J
  237: 37, // K
  238: 38, // L
  244: 44, // Z
  245: 45, // X
  246: 46, // C
  247: 47, // V
  248: 48, // B
  249: 49, // N
  250: 50, // M
  302: 2, // '!'
  303: 3, // '@'
  304: 4, // '#'
  305: 5, // '$'
  306: 6, // '%'
  307: 7, // '&'
  308: 8, // '*' (KEYCODE_ANDD)
  309: 9, // '('
  310: 10, // ')'
  311: 11, // '_'
  312: 12, // '+'
  317: 17, // W
  326: 26, // '{'
  327: 27, // '}'
  339: 39, // ':'
  340: 40, // '"'
  341: 41, // '~'
  343: 43, // '|'
  351: 51, // '<'
  352: 52, // '>'
};

export function isShiftedKey(keyCode: number): boolean {
  return keyCode in SHIFTED_KEY_MAP;
}

export function resolveShiftedKey(keyCode: number): number {
  return SHIFTED_KEY_MAP[keyCode] ?? keyCode;
}

// ---------------------------------------------------------------------------
// UI-facing types (kept from the original scaffold, extended)
// ---------------------------------------------------------------------------

export type VinputEndpoint = {
  host: string;
  port: number;
  serviceName?: string;
};

export type StbServices = {
  access?: { controlUrl: string };
  vinput?: { controlUrl: string };
  mirror?: { controlUrl: string };
};

export type StbDevice = {
  id: string;
  name: string;
  host: string;
  udn?: string;
  descriptionUrl?: string;
  services?: StbServices;
  vinput?: VinputEndpoint;
  mirror?: {
    controlPort?: number;
    dataPort?: number;
  };
};

export type KeyAction = {
  label: string;
  keyCode: number;
  symbol: string;
  color?: string;
};

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(" ");
}

export const DEFAULT_KEYS: KeyAction[] = [
  { label: "Info", keyCode: KeyCode.INFO, symbol: "\u24d8" },
  { label: "Guide", keyCode: KeyCode.MENU, symbol: "\u25a4" },
  { label: "Back", keyCode: KeyCode.BACK, symbol: "\u2039" },
  { label: "Home", keyCode: KeyCode.HOME, symbol: "\u2302" },
  { label: "Volume \u2212", keyCode: KeyCode.VOLUME_DOWN, symbol: "\u2212" },
  { label: "Mute", keyCode: KeyCode.MUTE, symbol: "\u2301" },
  { label: "Volume +", keyCode: KeyCode.VOLUME_UP, symbol: "+" },
  { label: "Channel \u2212", keyCode: KeyCode.CH_DEC, symbol: "\u2212" },
  { label: "Channel +", keyCode: KeyCode.CH_INC, symbol: "+" },
  { label: "Red", keyCode: KeyCode.RED, symbol: "\u25cf", color: "#F07A83" },
  { label: "Green", keyCode: KeyCode.GREEN, symbol: "\u25cf", color: "#55D59F" },
  { label: "Yellow", keyCode: KeyCode.YELLOW, symbol: "\u25cf", color: "#F0C75E" },
  { label: "Blue", keyCode: KeyCode.BLUE, symbol: "\u25cf", color: "#6EA4FF" },
];

export const MOCK_DEVICE: StbDevice = {
  id: "demo-stb",
  name: "Living Room STB",
  host: "192.168.1.11",
  vinput: { host: "192.168.1.11", port: VINPUT_DEFAULT_PORT, serviceName: VINPUT_STATE_VARIABLE },
};
