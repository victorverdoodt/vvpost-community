// @ts-check
'use strict'

/**
 * Tipos do protocolo do Kafka (big-endian, strings com int16 de tamanho, arrays com int32,
 * varints em zigzag nos records), CRC32C dos record batches e o murmur2 do particionador
 * padrão do cliente Java.
 */

class KafkaError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

class Writer {
  constructor() {
    /** @type {Buffer[]} */
    this.parts = []
  }
  /** @param {Buffer} buf */
  raw(buf) {
    this.parts.push(buf)
    return this
  }
  /** @param {number} v */
  int8(v) {
    const b = Buffer.alloc(1)
    b.writeInt8(v)
    return this.raw(b)
  }
  /** @param {number} v */
  int16(v) {
    const b = Buffer.alloc(2)
    b.writeInt16BE(v)
    return this.raw(b)
  }
  /** @param {number} v */
  int32(v) {
    const b = Buffer.alloc(4)
    b.writeInt32BE(v)
    return this.raw(b)
  }
  /** @param {number} v */
  uint32(v) {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(v >>> 0)
    return this.raw(b)
  }
  /** @param {bigint | number} v */
  int64(v) {
    const b = Buffer.alloc(8)
    b.writeBigInt64BE(BigInt(v))
    return this.raw(b)
  }
  /** @param {boolean} v */
  bool(v) {
    return this.int8(v ? 1 : 0)
  }
  /** @param {string | null | undefined} v */
  string(v) {
    if (v === null || v === undefined) return this.int16(-1)
    const b = Buffer.from(v, 'utf8')
    return this.int16(b.length).raw(b)
  }
  /** @param {Buffer | null | undefined} v */
  bytes(v) {
    if (v === null || v === undefined) return this.int32(-1)
    return this.int32(v.length).raw(v)
  }
  /**
   * @template T
   * @param {T[] | null} items @param {(w: Writer, item: T) => void} each
   */
  array(items, each) {
    if (items === null) return this.int32(-1)
    this.int32(items.length)
    for (const item of items) each(this, item)
    return this
  }
  /** Varint com zigzag (int32 dos records). @param {number} v */
  varint(v) {
    let z = ((v << 1) ^ (v >> 31)) >>> 0
    const out = []
    while (z > 0x7f) {
      out.push((z & 0x7f) | 0x80)
      z >>>= 7
    }
    out.push(z)
    return this.raw(Buffer.from(out))
  }
  /** Varlong com zigzag (int64 dos records). @param {bigint | number} v */
  varlong(v) {
    const n = BigInt.asIntN(64, BigInt(v))
    let z = BigInt.asUintN(64, (n << 1n) ^ (n >> 63n))
    const out = []
    while (z > 0x7fn) {
      out.push(Number(z & 0x7fn) | 0x80)
      z >>= 7n
    }
    out.push(Number(z))
    return this.raw(Buffer.from(out))
  }
  /** Bytes com tamanho em varint (-1 para nulo), como a chave e o valor de um record. @param {Buffer | null} v */
  varbytes(v) {
    if (v === null) return this.varint(-1)
    return this.varint(v.length).raw(v)
  }
  build() {
    return Buffer.concat(this.parts)
  }
}

class Reader {
  /** @param {Buffer} buf */
  constructor(buf, pos = 0) {
    this.buf = buf
    this.pos = pos
  }
  /** @param {number} n */
  need(n) {
    if (this.pos + n > this.buf.length) throw new KafkaError('resposta do Kafka truncada', 'KAFKA_PROTOCOL')
  }
  remaining() {
    return this.buf.length - this.pos
  }
  int8() {
    this.need(1)
    return this.buf.readInt8(this.pos++)
  }
  int16() {
    this.need(2)
    const v = this.buf.readInt16BE(this.pos)
    this.pos += 2
    return v
  }
  int32() {
    this.need(4)
    const v = this.buf.readInt32BE(this.pos)
    this.pos += 4
    return v
  }
  uint32() {
    this.need(4)
    const v = this.buf.readUInt32BE(this.pos)
    this.pos += 4
    return v
  }
  int64() {
    this.need(8)
    const v = this.buf.readBigInt64BE(this.pos)
    this.pos += 8
    return v
  }
  bool() {
    return this.int8() !== 0
  }
  /** @returns {string | null} */
  string() {
    const len = this.int16()
    if (len < 0) return null
    this.need(len)
    const v = this.buf.toString('utf8', this.pos, this.pos + len)
    this.pos += len
    return v
  }
  /** @returns {Buffer | null} */
  bytes() {
    const len = this.int32()
    if (len < 0) return null
    return this.take(len)
  }
  /** @param {number} n */
  take(n) {
    this.need(n)
    const v = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return v
  }
  /**
   * @template T
   * @param {(r: Reader) => T} each @returns {T[]}
   */
  array(each) {
    const len = this.int32()
    /** @type {T[]} */
    const out = []
    for (let i = 0; i < len; i++) out.push(each(this))
    return out
  }
  varint() {
    let z = 0
    let shift = 0
    for (;;) {
      this.need(1)
      const b = /** @type {number} */ (this.buf[this.pos++])
      z |= (b & 0x7f) << shift
      if (!(b & 0x80)) break
      shift += 7
      if (shift > 28) throw new KafkaError('varint inválido', 'KAFKA_PROTOCOL')
    }
    return (z >>> 1) ^ -(z & 1)
  }
  varlong() {
    let z = 0n
    let shift = 0n
    for (;;) {
      this.need(1)
      const b = /** @type {number} */ (this.buf[this.pos++])
      z |= BigInt(b & 0x7f) << shift
      if (!(b & 0x80)) break
      shift += 7n
      if (shift > 63n) throw new KafkaError('varlong inválido', 'KAFKA_PROTOCOL')
    }
    return BigInt.asIntN(64, (z >> 1n) ^ -(z & 1n))
  }
  /** @returns {Buffer | null} */
  varbytes() {
    const len = this.varint()
    if (len < 0) return null
    return this.take(len)
  }
}

const CRC32C_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** CRC32C (Castagnoli), o checksum do record batch v2. @param {Buffer} buf */
function crc32c(buf) {
  let crc = -1
  for (const byte of buf) crc = /** @type {number} */ (CRC32C_TABLE[(crc ^ byte) & 0xff]) ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/** murmur2 do Kafka (org.apache.kafka.common.utils.Utils.murmur2), com sinal. @param {Buffer} data */
function murmur2(data) {
  const length = data.length
  const m = 0x5bd1e995
  let h = 0x9747b28c ^ length
  const length4 = length >> 2
  for (let i = 0; i < length4; i++) {
    let k = data.readInt32LE(i << 2)
    k = Math.imul(k, m)
    k ^= k >>> 24
    k = Math.imul(k, m)
    h = Math.imul(h, m)
    h ^= k
  }
  const tail = length & ~3
  switch (length % 4) {
    case 3:
      h ^= /** @type {number} */ (data[tail + 2]) << 16
    // falls through
    case 2:
      h ^= /** @type {number} */ (data[tail + 1]) << 8
    // falls through
    case 1:
      h ^= /** @type {number} */ (data[tail])
      h = Math.imul(h, m)
  }
  h ^= h >>> 13
  h = Math.imul(h, m)
  h ^= h >>> 15
  return h | 0
}

/** Partição de uma chave, como o particionador padrão do Java. @param {Buffer} key @param {number} partitions */
function partitionFor(key, partitions) {
  return (murmur2(key) & 0x7fffffff) % partitions
}

module.exports = { KafkaError, Writer, Reader, crc32c, murmur2, partitionFor }
