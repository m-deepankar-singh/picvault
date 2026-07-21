import _sodium from 'libsodium-wrappers-sumo';

let ready: Promise<typeof _sodium> | null = null;

export function getSodium(): Promise<typeof _sodium> {
  if (!ready) {
    ready = _sodium.ready.then(() => _sodium);
  }
  return ready;
}

export async function toB64(bytes: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

export async function fromB64(b64: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  return sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
}
