import { getSodium } from './sodium';

// Short authentication string over both identity keys, order-independent.
// Two users compare these 12 five-digit groups out-of-band; a match proves
// the server did not substitute public keys (MITM).
export async function safetyNumber(pubA_B64: string, pubB_B64: string): Promise<string> {
  const sodium = await getSodium();
  const [first, second] = [pubA_B64, pubB_B64].sort();
  const hash = sodium.crypto_generichash(32, `picvault-safety:${first}:${second}`);
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    const a = hash[i * 2]!;
    const b = hash[i * 2 + 1]!;
    groups.push((((a << 8) | b) % 100000).toString().padStart(5, '0'));
  }
  return groups.join(' ');
}
