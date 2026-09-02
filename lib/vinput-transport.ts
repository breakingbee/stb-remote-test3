import { Platform } from "react-native";

import {
  buildKeyboardRequest,
  buildMouseRequest,
  buildTouchRequest,
  KEY_STATE_DOWN,
  KEY_STATE_UP,
  KeyCode,
  isShiftedKey,
  resolveShiftedKey,
  type TouchFinger,
  type VinputEndpoint,
} from "@/lib/stb-protocol";

type UdpSocket = {
  bind: (port?: number) => void;
  close: () => void;
  send: (message: Uint8Array, offset: number, length: number, port: number, host: string, callback?: (error?: Error) => void) => void;
};

type DgramModule = {
  createSocket: (options: { type: "udp4" }) => UdpSocket;
};

function loadDgram(): DgramModule | null {
  if (Platform.OS === "web") return null;
  try {
    // react-native-udp is loaded only in a native development build.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("react-native-udp").default ?? require("react-native-udp");
  } catch {
    return null;
  }
}

type SendResult = { ok: true; bytes: number } | { ok: false; reason: string };

/**
 * Fire-and-forget UDP sender for the Vinput protocol (keyboard, mouse, touch).
 * Mirrors UDPClient.send() — one socket, reused across every packet, closed
 * explicitly when the remote screen unmounts or the device changes.
 */
export class VinputTransport {
  private socket: UdpSocket | null = null;

  constructor(private endpoint: VinputEndpoint) {}

  get isAvailable() {
    return Boolean(this.endpoint.host && this.endpoint.port > 0 && loadDgram());
  }

  updateEndpoint(endpoint: VinputEndpoint) {
    this.endpoint = endpoint;
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }

  private ensureSocket(): UdpSocket | null {
    const dgram = loadDgram();
    if (!dgram) return null;
    if (!this.socket) {
      this.socket = dgram.createSocket({ type: "udp4" });
      this.socket.bind(0);
    }
    return this.socket;
  }

  private sendPacket(payload: Uint8Array): SendResult {
    if (!this.endpoint.port) return { ok: false, reason: "no_vinput_port" };
    const socket = this.ensureSocket();
    if (!socket) return { ok: false, reason: "native_udp_unavailable" };
    let callbackError: Error | undefined;
    socket.send(payload, 0, payload.length, this.endpoint.port, this.endpoint.host, (error) => {
      callbackError = error;
    });
    return callbackError ? { ok: false, reason: callbackError.message } : { ok: true, bytes: payload.length };
  }

  // -- Keyboard ------------------------------------------------------------

  sendKeyDown(keyCode: number) {
    return this.sendPacket(buildKeyboardRequest(keyCode, KEY_STATE_DOWN));
  }

  sendKeyUp(keyCode: number) {
    return this.sendPacket(buildKeyboardRequest(keyCode, KEY_STATE_UP));
  }

  /**
   * Sends a full down+up tap. Reproduces RemoteKeyboard.sendDownAndUpKeyCode(): a
   * "shifted" key code (letters, punctuation) is sent as SHIFT_LEFT down, base-key
   * down+up, SHIFT_LEFT up, instead of the raw shifted code.
   */
  sendTap(keyCode: number) {
    if (isShiftedKey(keyCode)) {
      const base = resolveShiftedKey(keyCode);
      this.sendKeyDown(KeyCode.SHIFT_LEFT);
      this.sendKeyDown(base);
      this.sendKeyUp(base);
      const up = this.sendKeyUp(KeyCode.SHIFT_LEFT);
      return up;
    }
    this.sendKeyDown(keyCode);
    return this.sendKeyUp(keyCode);
  }

  // -- Mouse -----------------------------------------------------------------

  sendMouseMove(dx: number, dy: number) {
    return this.sendPacket(buildMouseRequest(256 /* MouseClickType.MOVE */, dx, dy));
  }

  sendMouseClick(clickType: number) {
    return this.sendPacket(buildMouseRequest(clickType, 0, 0));
  }

  sendMouseWheel(direction: "up" | "down") {
    const dx = direction === "up" ? 10 : -10;
    return this.sendPacket(buildMouseRequest(774 /* MouseClickType.WHEEL */, dx, 0));
  }

  // -- Touch -------------------------------------------------------------

  sendTouch(fingers: TouchFinger[]) {
    return this.sendPacket(buildTouchRequest(fingers));
  }
}
