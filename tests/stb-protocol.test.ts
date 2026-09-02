import { describe, expect, it } from "vitest";

import {
  buildKeyboardRequest,
  buildMouseRequest,
  buildTouchRequest,
  bytesToHex,
  isShiftedKey,
  MouseClickType,
  resolveShiftedKey,
} from "@/lib/stb-protocol";

describe("MSGHeadObject header layout (shared by every Vinput packet)", () => {
  it("writes sndModuleName, rcvModuleName, msgType, msgLen in that wire order", () => {
    const packet = buildKeyboardRequest(165, 1);
    // offset 0-1: sndModuleName = 1 (MTSC_MODULE_RC_APP)
    expect(packet[0]).toBe(1);
    expect(packet[1]).toBe(0);
    // offset 2-3: rcvModuleName = 2 (MTSC_MODULE_RC_CENTER)
    expect(packet[2]).toBe(2);
    expect(packet[3]).toBe(0);
    // offset 4-5: msgType = 2 (MTSC_MSGTYPE_KEYBOARD)
    expect(packet[4]).toBe(2);
    expect(packet[5]).toBe(0);
    // offset 6-7: msgLen = 22 (little-endian u16)
    expect(packet[6]).toBe(22);
    expect(packet[7]).toBe(0);
    // offset 8-11: reserved, always zero
    expect(Array.from(packet.slice(8, 12))).toEqual([0, 0, 0, 0]);
  });
});

describe("HiSilicon Vinput keyboard protocol (KeyboardRequest.java)", () => {
  it("creates the 22-byte key-down packet with the 0x0107 event marker", () => {
    const packet = buildKeyboardRequest(165, 1);
    expect(packet).toHaveLength(22);
    // offset 12-13: marker 0x0107 (little-endian: 07 01)
    // offset 14-17: keyCode = 165 = 0xa5
    // offset 18-21: state = 1
    expect(bytesToHex(packet.slice(12))).toBe("07 01 a5 00 00 00 01 00 00 00");
  });

  it("changes only the key and state fields between press and release", () => {
    const down = buildKeyboardRequest(23, 1);
    const up = buildKeyboardRequest(23, 0);
    expect(Array.from(down.slice(0, 18))).toEqual(Array.from(up.slice(0, 18)));
    expect(Array.from(down.slice(18))).not.toEqual(Array.from(up.slice(18)));
  });
});

describe("Shifted key mapping (RemoteKeyboard.sendDownAndUpKeyCode)", () => {
  it("recognizes uppercase-letter and punctuation key codes as shifted", () => {
    expect(isShiftedKey(230)).toBe(true); // KEYCODE_A
    expect(isShiftedKey(11)).toBe(false); // KEYCODE_0, not shifted
  });

  it("resolves a shifted key code to its unshifted base key", () => {
    expect(resolveShiftedKey(230)).toBe(30); // A -> a
    expect(resolveShiftedKey(303)).toBe(3); // '@' -> '2'
  });
});

describe("HiSilicon Vinput mouse protocol (MouseRequest.java)", () => {
  it("creates a 22-byte move packet with dx/dy as truncated 32-bit ints", () => {
    const packet = buildMouseRequest(MouseClickType.MOVE, 12.9, -7.4);
    expect(packet).toHaveLength(22);
    expect(packet[4]).toBe(3); // msgType = MTSC_MSGTYPE_MOUSE
    const view = new DataView(packet.buffer);
    expect(view.getUint16(12, true)).toBe(MouseClickType.MOVE);
    expect(view.getInt32(14, true)).toBe(12);
    expect(view.getInt32(18, true)).toBe(-7);
  });

  it("encodes wheel events with the documented +/-10 delta", () => {
    const packet = buildMouseRequest(MouseClickType.WHEEL, 10, 0);
    const view = new DataView(packet.buffer);
    expect(view.getUint16(12, true)).toBe(MouseClickType.WHEEL);
    expect(view.getInt32(14, true)).toBe(10);
  });
});

describe("HiSilicon Vinput touch protocol (TouchRequest.java)", () => {
  it("creates a 76-byte packet and fills unused finger slots with zero", () => {
    const packet = buildTouchRequest([{ x: 100, y: 200, pressed: true }]);
    expect(packet).toHaveLength(76);
    expect(packet[4]).toBe(4); // msgType = MTSC_MSGTYPE_TOUCH
    const view = new DataView(packet.buffer);
    expect(view.getUint32(12, true)).toBe(1); // fingerCount
    expect(view.getInt32(16, true)).toBe(100);
    expect(view.getInt32(20, true)).toBe(200);
    expect(view.getUint32(24, true)).toBe(1); // pressed
    // second finger slot must be zeroed
    expect(view.getInt32(28, true)).toBe(0);
    expect(view.getInt32(32, true)).toBe(0);
    expect(view.getUint32(36, true)).toBe(0);
  });

  it("caps at 5 simultaneous fingers", () => {
    const fingers = Array.from({ length: 8 }, (_, i) => ({ x: i, y: i, pressed: true }));
    const packet = buildTouchRequest(fingers);
    const view = new DataView(packet.buffer);
    expect(view.getUint32(12, true)).toBe(5);
  });
});
