import * as desjs from "des.js";

const VNC_PASSWORD_BYTES = 8;

function reverseBits(value: number): number {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    reversed = (reversed << 1) | ((value >> bit) & 1);
  }
  return reversed;
}

/**
 * Encrypt a 16-byte VNC challenge with the TigerVNC-compatible DES flow.
 */
export function encryptVncChallenge(challenge: Uint8Array, password: string): Uint8Array {
  const passwordBytes = new TextEncoder().encode(password);
  const key = new Uint8Array(VNC_PASSWORD_BYTES);

  for (let index = 0; index < VNC_PASSWORD_BYTES; index += 1) {
    key[index] = reverseBits(passwordBytes[index] ?? 0);
  }

  const cipher = desjs.DES.create({
    type: "encrypt",
    key: Array.from(key),
    padding: false,
  });

  const encrypted = cipher.update(Array.from(challenge)).concat(cipher.final());
  return new Uint8Array(encrypted);
}
