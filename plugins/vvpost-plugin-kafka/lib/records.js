// @ts-check
'use strict'

/**
 * RecordBatch v2 (magic 2, Kafka 0.11+): escrita de um batch com os records de uma
 * produção e leitura dos batches de um Fetch (o último pode vir cortado pelo limite de
 * bytes e é ignorado). Formatos antigos (magic 0 e 1) não são lidos.
 */

const { KafkaError, Writer, Reader, crc32c } = require('./wire')
const { compress, decompress, CODECS } = require('./compression')

/**
 * @typedef {{ key: Buffer | null, value: Buffer | null, headers?: [string, Buffer | null][], timestamp?: number }} OutRecord
 * @typedef {{ offset: bigint, timestamp: bigint, key: Buffer | null, value: Buffer | null, headers: [string, Buffer | null][] }} InRecord
 * @typedef {{ baseOffset: bigint, lastOffset: bigint, control: boolean, codec: string, records: InRecord[] }} Batch
 */

/** @param {OutRecord[]} records @param {number} codec */
function encodeBatch(records, codec = 0) {
  const now = Date.now()
  const base = records[0]?.timestamp ?? now
  let max = base
  const body = new Writer()
  records.forEach((r, i) => {
    const ts = r.timestamp ?? now
    if (ts > max) max = ts
    const rec = new Writer()
      .int8(0)
      .varlong(ts - base)
      .varint(i)
      .varbytes(r.key)
      .varbytes(r.value)
      .varint(r.headers?.length ?? 0)
    for (const [k, v] of r.headers ?? []) rec.varbytes(Buffer.from(k, 'utf8')).varbytes(v)
    const bytes = rec.build()
    body.varint(bytes.length).raw(bytes)
  })
  const payload = compress(codec, body.build())
  // Do atributos ao fim: é o que o CRC cobre.
  const tail = new Writer()
    .int16(codec & 7)
    .int32(records.length - 1)
    .int64(base)
    .int64(max)
    .int64(-1) // producerId: sem idempotência
    .int16(-1)
    .int32(-1)
    .int32(records.length)
    .raw(payload)
    .build()
  const head = new Writer()
    .int64(0)
    .int32(4 + 1 + 4 + tail.length) // partitionLeaderEpoch + magic + crc + resto
    .int32(-1)
    .int8(2)
    .uint32(crc32c(tail))
    .build()
  return Buffer.concat([head, tail])
}

/** @param {Buffer} data @param {bigint} baseOffset @param {bigint} baseTimestamp @param {number} count */
function decodeRecords(data, baseOffset, baseTimestamp, count) {
  const r = new Reader(data)
  /** @type {InRecord[]} */
  const out = []
  for (let i = 0; i < count; i++) {
    const length = r.varint()
    const end = r.pos + length
    r.int8()
    const tsDelta = r.varlong()
    const offsetDelta = r.varint()
    const key = r.varbytes()
    const value = r.varbytes()
    const n = r.varint()
    /** @type {[string, Buffer | null][]} */
    const headers = []
    for (let h = 0; h < n; h++) {
      const k = r.varbytes()
      headers.push([k ? k.toString('utf8') : '', r.varbytes()])
    }
    if (r.pos !== end) throw new KafkaError('record com tamanho que não confere', 'KAFKA_PROTOCOL')
    out.push({ offset: baseOffset + BigInt(offsetDelta), timestamp: baseTimestamp + tsDelta, key, value, headers })
  }
  return out
}

/**
 * Os batches completos de um campo records do Fetch.
 * @param {Buffer} data @returns {Batch[]}
 */
function decodeBatches(data) {
  /** @type {Batch[]} */
  const batches = []
  let pos = 0
  while (pos + 17 <= data.length) {
    const baseOffset = data.readBigInt64BE(pos)
    const length = data.readInt32BE(pos + 8)
    const end = pos + 12 + length
    if (end > data.length) break // batch cortado pelo limite de bytes
    const magic = data.readInt8(pos + 16)
    if (magic !== 2) throw new KafkaError(`mensagens no formato antigo (magic ${magic}), que o plugin não lê`, 'KAFKA_PROTOCOL')
    const r = new Reader(data.subarray(pos, end), 17)
    const crc = r.uint32()
    if (crc32c(data.subarray(pos + 21, end)) !== crc) throw new KafkaError('record batch com CRC inválido', 'KAFKA_PROTOCOL')
    const attributes = r.int16()
    const lastOffsetDelta = r.int32()
    const baseTimestamp = r.int64()
    const maxTimestamp = r.int64()
    r.int64() // producerId
    r.int16() // producerEpoch
    r.int32() // baseSequence
    const count = r.int32()
    const codec = attributes & 7
    const control = !!(attributes & 0x20)
    const records = control ? [] : decodeRecords(decompress(codec, r.take(r.remaining())), baseOffset, baseTimestamp, count)
    // LogAppendTime (bit 3): a hora de todos os records é a do broker, em maxTimestamp.
    if (attributes & 0x08) for (const rec of records) rec.timestamp = maxTimestamp
    batches.push({ baseOffset, lastOffset: baseOffset + BigInt(lastOffsetDelta), control, codec: CODECS[codec] ?? String(codec), records })
    pos = end
  }
  return batches
}

module.exports = { encodeBatch, decodeBatches }
