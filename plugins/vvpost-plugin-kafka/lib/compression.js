// @ts-check
'use strict'

/**
 * Compressão dos record batches: gzip e zstd pelo node:zlib; snappy (bruto ou no
 * enquadramento do xerial, que o cliente Java usa) e LZ4 frame lidos aqui mesmo, sem
 * dependência nativa.
 */

const zlib = require('node:zlib')
const { KafkaError } = require('./wire')

/** Atributo de compressão do batch (bits 0-2) → nome. */
const CODECS = /** @type {const} */ (['none', 'gzip', 'snappy', 'lz4', 'zstd'])
/** Teto da saída descomprimida de um batch (um batch de 1 GB não cabe no processo do plugin). */
const MAX_OUTPUT = 128 * 1024 * 1024

/** @param {number} size */
function checkSize(size) {
  if (size > MAX_OUTPUT) throw new KafkaError(`batch descomprimido grande demais (${size} bytes)`, 'KAFKA_COMPRESSION')
}

/** Snappy bruto (o formato de bloco). @param {Buffer} input */
function snappyRaw(input) {
  let pos = 0
  let length = 0
  for (let shift = 0; ; shift += 7) {
    if (pos >= input.length || shift > 28) throw new KafkaError('snappy: tamanho inválido', 'KAFKA_COMPRESSION')
    const b = /** @type {number} */ (input[pos++])
    length += (b & 0x7f) * 2 ** shift
    if (!(b & 0x80)) break
  }
  checkSize(length)
  const out = Buffer.alloc(length)
  let o = 0
  while (pos < input.length) {
    const tag = /** @type {number} */ (input[pos++])
    const kind = tag & 3
    if (kind === 0) {
      let len = tag >>> 2
      if (len >= 60) {
        const extra = len - 59
        len = 0
        for (let i = 0; i < extra; i++) len |= /** @type {number} */ (input[pos + i]) << (8 * i)
        len >>>= 0
        pos += extra
      }
      len += 1
      if (pos + len > input.length || o + len > length) throw new KafkaError('snappy: literal fora dos limites', 'KAFKA_COMPRESSION')
      input.copy(out, o, pos, pos + len)
      pos += len
      o += len
      continue
    }
    let len
    let offset
    if (kind === 1) {
      len = ((tag >>> 2) & 7) + 4
      offset = ((tag >>> 5) << 8) | /** @type {number} */ (input[pos++])
    } else if (kind === 2) {
      len = (tag >>> 2) + 1
      offset = /** @type {number} */ (input[pos]) | (/** @type {number} */ (input[pos + 1]) << 8)
      pos += 2
    } else {
      len = (tag >>> 2) + 1
      offset = input.readUInt32LE(pos)
      pos += 4
    }
    if (offset === 0 || offset > o || o + len > length) throw new KafkaError('snappy: cópia fora dos limites', 'KAFKA_COMPRESSION')
    for (let i = 0; i < len; i++, o++) out[o] = /** @type {number} */ (out[o - offset])
  }
  if (o !== length) throw new KafkaError('snappy: tamanho não confere', 'KAFKA_COMPRESSION')
  return out
}

const XERIAL_MAGIC = Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00])

/** Snappy do Kafka: enquadramento do xerial (cabeçalho de 16 bytes e blocos com tamanho), ou bruto. @param {Buffer} input */
function snappy(input) {
  if (input.length < 16 || !input.subarray(0, 8).equals(XERIAL_MAGIC)) return snappyRaw(input)
  /** @type {Buffer[]} */
  const parts = []
  let total = 0
  let pos = 16
  while (pos < input.length) {
    if (pos + 4 > input.length) throw new KafkaError('snappy: bloco truncado', 'KAFKA_COMPRESSION')
    const size = input.readInt32BE(pos)
    pos += 4
    if (size < 0 || pos + size > input.length) throw new KafkaError('snappy: bloco truncado', 'KAFKA_COMPRESSION')
    const part = snappyRaw(input.subarray(pos, pos + size))
    total += part.length
    checkSize(total)
    parts.push(part)
    pos += size
  }
  return Buffer.concat(parts)
}

/**
 * Um bloco LZ4 descomprimido em `out` a partir de `o` (os blocos ligados copiam do que
 * já saiu antes). Devolve a nova posição.
 * @param {Buffer} block @param {Buffer} out @param {number} o
 */
function lz4Block(block, out, o) {
  let pos = 0
  for (;;) {
    if (pos >= block.length) throw new KafkaError('lz4: bloco truncado', 'KAFKA_COMPRESSION')
    const token = /** @type {number} */ (block[pos++])
    let lit = token >>> 4
    if (lit === 15) {
      let b
      do {
        if (pos >= block.length) throw new KafkaError('lz4: bloco truncado', 'KAFKA_COMPRESSION')
        b = /** @type {number} */ (block[pos++])
        lit += b
      } while (b === 255)
    }
    if (pos + lit > block.length || o + lit > out.length) throw new KafkaError('lz4: literal fora dos limites', 'KAFKA_COMPRESSION')
    block.copy(out, o, pos, pos + lit)
    pos += lit
    o += lit
    if (pos === block.length) return o
    if (pos + 2 > block.length) throw new KafkaError('lz4: bloco truncado', 'KAFKA_COMPRESSION')
    const offset = /** @type {number} */ (block[pos]) | (/** @type {number} */ (block[pos + 1]) << 8)
    pos += 2
    let len = token & 15
    if (len === 15) {
      let b
      do {
        if (pos >= block.length) throw new KafkaError('lz4: bloco truncado', 'KAFKA_COMPRESSION')
        b = /** @type {number} */ (block[pos++])
        len += b
      } while (b === 255)
    }
    len += 4
    if (offset === 0 || offset > o || o + len > out.length) throw new KafkaError('lz4: cópia fora dos limites', 'KAFKA_COMPRESSION')
    for (let i = 0; i < len; i++, o++) out[o] = /** @type {number} */ (out[o - offset])
  }
}

const LZ4_BLOCK_SIZES = /** @type {Record<number, number>} */ ({ 4: 64 << 10, 5: 256 << 10, 6: 1 << 20, 7: 4 << 20 })

/** LZ4 frame (o formato do Kafka para lz4 nos batches v2). @param {Buffer} input */
function lz4(input) {
  if (input.length < 7 || input.readUInt32LE(0) !== 0x184d2204) throw new KafkaError('lz4: não é um frame LZ4', 'KAFKA_COMPRESSION')
  const flg = /** @type {number} */ (input[4])
  if (flg >>> 6 !== 1) throw new KafkaError('lz4: versão de frame desconhecida', 'KAFKA_COMPRESSION')
  const blockChecksum = !!(flg & 0x10)
  const contentSize = !!(flg & 0x08)
  const dictId = !!(flg & 0x01)
  const blockMax = LZ4_BLOCK_SIZES[(/** @type {number} */ (input[5]) >>> 4) & 7]
  if (!blockMax) throw new KafkaError('lz4: tamanho de bloco inválido', 'KAFKA_COMPRESSION')
  let pos = 6 + (contentSize ? 8 : 0) + (dictId ? 4 : 0) + 1
  /** @type {Buffer[]} */
  const blocks = []
  let total = 0
  for (;;) {
    if (pos + 4 > input.length) throw new KafkaError('lz4: frame truncado', 'KAFKA_COMPRESSION')
    const word = input.readUInt32LE(pos)
    pos += 4
    if (word === 0) break
    const size = word & 0x7fffffff
    if (size > blockMax || pos + size > input.length) throw new KafkaError('lz4: bloco fora dos limites', 'KAFKA_COMPRESSION')
    blocks.push(input.subarray(pos, pos + size), Buffer.from([word >>> 31]))
    total += word >>> 31 ? size : blockMax
    checkSize(total)
    pos += size + (blockChecksum ? 4 : 0)
  }
  // Saída do tamanho máximo possível; blocos ligados copiam de blocos anteriores.
  const out = Buffer.alloc(total)
  let o = 0
  for (let i = 0; i < blocks.length; i += 2) {
    const block = /** @type {Buffer} */ (blocks[i])
    if (/** @type {Buffer} */ (blocks[i + 1])[0]) {
      block.copy(out, o)
      o += block.length
    } else o = lz4Block(block, out, o)
  }
  return out.subarray(0, o)
}

/** @param {number} codec @param {Buffer} data */
function decompress(codec, data) {
  switch (codec) {
    case 0:
      return data
    case 1:
      return zlib.gunzipSync(data, { maxOutputLength: MAX_OUTPUT })
    case 2:
      return snappy(data)
    case 3:
      return lz4(data)
    case 4:
      if (!zlib.zstdDecompressSync) throw new KafkaError('zstd não está disponível neste Node', 'KAFKA_COMPRESSION')
      return zlib.zstdDecompressSync(data, { maxOutputLength: MAX_OUTPUT })
    default:
      throw new KafkaError(`compressão ${codec} desconhecida`, 'KAFKA_COMPRESSION')
  }
}

/** Compressões que o plugin escreve ao produzir. */
const WRITABLE = /** @type {Record<string, number>} */ ({ none: 0, gzip: 1, zstd: 4 })

/** @param {number} codec @param {Buffer} data */
function compress(codec, data) {
  if (codec === 0) return data
  if (codec === 1) return zlib.gzipSync(data)
  if (codec === 4) {
    if (!zlib.zstdCompressSync) throw new KafkaError('zstd não está disponível neste Node', 'KAFKA_COMPRESSION')
    return zlib.zstdCompressSync(data)
  }
  throw new KafkaError(`o plugin não comprime com ${CODECS[codec] ?? codec}`, 'CONFIG_ERROR')
}

module.exports = { CODECS, WRITABLE, compress, decompress, snappy, snappyRaw, lz4 }
