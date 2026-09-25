/** SHA-256 em hex minúsculo — o formato que o upload com dedup recebe. */
export async function sha256Hex(
  data: Blob | ArrayBuffer | Uint8Array<ArrayBuffer>,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data
  const digest = await subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
