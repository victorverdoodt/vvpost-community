// Sem dependências: o servidor de webhooks usa isto sem carregar o undici do dispatcher.

const TEXT_TYPE = /^text\/|[+/](json|xml|yaml|javascript|ecmascript|graphql|x-www-form-urlencoded|x-ndjson)$/i
const BINARY_TYPE = /^(image|audio|video|font)\/|^application\/(pdf|octet-stream|zip|gzip|x-tar|x-7z-compressed|x-rar-compressed|vnd\.|msword|x-protobuf|protobuf|x-msgpack|msgpack|wasm|java-archive)/i

/**
 * O corpo é binário (imagem, PDF, arquivo...)? Pelo content-type quando ele é conhecido; sem ele,
 * pelos bytes: NUL nos primeiros 1024 ou UTF-8 inválido. SVG é texto (vai como XML).
 */
export function isBinaryBody(contentType: string | undefined, bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  const type = contentType?.split(';')[0]!.trim() ?? ''
  if (type && TEXT_TYPE.test(type)) return false
  if (type && BINARY_TYPE.test(type)) return true
  if (bytes.subarray(0, 1024).includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 64 * 1024))
    return false
  } catch {
    // Um caractere multibyte cortado no fim da amostra não torna o corpo binário.
    return bytes.length <= 64 * 1024 || !isCutAtBoundary(bytes.subarray(0, 64 * 1024))
  }
}

function isCutAtBoundary(sample: Uint8Array): boolean {
  for (let cut = 1; cut <= 3; cut++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - cut))
      return true
    } catch {
      // tenta cortar mais um byte
    }
  }
  return false
}
