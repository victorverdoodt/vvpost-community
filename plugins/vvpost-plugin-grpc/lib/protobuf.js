// @ts-check
'use strict'

/**
 * Tipos do Protocol Buffers e o codec binário, com o mapeamento JSON do proto3 (nomes em
 * lowerCamelCase, int64 em texto, bytes em base64, enums pelo nome) e os tipos bem
 * conhecidos (Timestamp, Duration, wrappers, Struct, Value, ListValue, Empty, FieldMask, Any).
 */

const { parseProto } = require('./proto-parser')

const SCALARS = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
  'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes'
])
const SIXTY_FOUR = new Set(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64'])
const PACKABLE = new Set([...SCALARS].filter((t) => t !== 'string' && t !== 'bytes'))
/** Tipo de fio de cada escalar: 0 varint, 1 64 bits, 2 com tamanho, 5 32 bits. */
const WIRE = {
  double: 1, float: 5, int32: 0, int64: 0, uint32: 0, uint64: 0, sint32: 0, sint64: 0,
  fixed32: 5, fixed64: 1, sfixed32: 5, sfixed64: 1, bool: 0, string: 2, bytes: 2
}

/** Tipos bem conhecidos, só o necessário para o codec e o JSON. */
const WELL_KNOWN = {
  'google/protobuf/timestamp.proto': 'syntax = "proto3"; package google.protobuf; message Timestamp { int64 seconds = 1; int32 nanos = 2; }',
  'google/protobuf/duration.proto': 'syntax = "proto3"; package google.protobuf; message Duration { int64 seconds = 1; int32 nanos = 2; }',
  'google/protobuf/empty.proto': 'syntax = "proto3"; package google.protobuf; message Empty {}',
  'google/protobuf/field_mask.proto': 'syntax = "proto3"; package google.protobuf; message FieldMask { repeated string paths = 1; }',
  'google/protobuf/any.proto': 'syntax = "proto3"; package google.protobuf; message Any { string type_url = 1; bytes value = 2; }',
  'google/protobuf/struct.proto': `syntax = "proto3"; package google.protobuf;
    message Struct { map<string, Value> fields = 1; }
    message Value { oneof kind { NullValue null_value = 1; double number_value = 2; string string_value = 3; bool bool_value = 4; Struct struct_value = 5; ListValue list_value = 6; } }
    enum NullValue { NULL_VALUE = 0; }
    message ListValue { repeated Value values = 1; }`,
  'google/protobuf/wrappers.proto': `syntax = "proto3"; package google.protobuf;
    message DoubleValue { double value = 1; } message FloatValue { float value = 1; }
    message Int64Value { int64 value = 1; } message UInt64Value { uint64 value = 1; }
    message Int32Value { int32 value = 1; } message UInt32Value { uint32 value = 1; }
    message BoolValue { bool value = 1; } message StringValue { string value = 1; } message BytesValue { bytes value = 1; }`
}
const WRAPPERS = new Set(['DoubleValue', 'FloatValue', 'Int64Value', 'UInt64Value', 'Int32Value', 'UInt32Value', 'BoolValue', 'StringValue', 'BytesValue'].map((n) => `google.protobuf.${n}`))

class ProtoError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'PROTO_ERROR') {
    super(message)
    this.code = code
  }
}

/** @param {string} name */
const lowerCamel = (name) => name.replace(/_+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase())

/**
 * @typedef {{ name: string, jsonName: string, number: number, repeated: boolean, type: string, typeName?: string,
 *   packed?: boolean, oneof?: string, optional?: boolean, map?: { key: string, value: Field } }} Field
 * @typedef {{ kind: 'message', fullName: string, fields: Field[], byNumber: Map<number, Field>, byName: Map<string, Field>, syntax: string }} MessageType
 * @typedef {{ kind: 'enum', fullName: string, values: Map<string, number>, names: Map<number, string> }} EnumType
 * @typedef {{ fullName: string, methods: Map<string, Method> }} Service
 * @typedef {{ name: string, input: string, output: string, clientStreaming: boolean, serverStreaming: boolean }} Method
 * @typedef {{ kind: 'message', fullName: string, scope: string, syntax: string, fields: import('./proto-parser').RawField[] }
 *   | { kind: 'enum', fullName: string, values: [string, number][] }} PendingType
 */

/** Tipos e serviços carregados de .proto ou de descritores (reflection), com os nomes resolvidos. */
class Registry {
  constructor() {
    /** @type {Map<string, MessageType | EnumType>} */
    this.types = new Map()
    /** @type {Map<string, Service>} */
    this.services = new Map()
    /** @type {Set<string>} */
    this.files = new Set()
    /** @type {PendingType[]} */
    this.pending = []
    /** @type {{ fullName: string, scope: string, methods: import('./proto-parser').RawMethod[] }[]} */
    this.pendingServices = []
  }

  /** Lê o texto de um ou mais .proto (cada syntax começa um arquivo). @param {string} text */
  addProto(text, name = 'input.proto') {
    for (const file of parseProto(text, name)) this.addRawFile(file)
    return this
  }

  /** @param {import('./proto-parser').RawFile} file */
  addRawFile(file) {
    if (this.files.has(file.name)) return
    this.files.add(file.name)
    for (const dep of file.imports) {
      const wkt = /** @type {Record<string, string>} */ (WELL_KNOWN)[dep]
      if (wkt && !this.files.has(dep)) this.addProto(wkt, dep)
    }
    const prefix = file.package ? `${file.package}.` : ''
    /** @param {import('./proto-parser').RawType} t @param {string} scope */
    const add = (t, scope) => {
      const fullName = scope ? `${scope}.${t.name}` : t.name
      if (t.kind === 'enum') this.pending.push({ kind: 'enum', fullName, values: t.values })
      else {
        this.pending.push({ kind: 'message', fullName, scope: fullName, syntax: file.syntax, fields: t.fields })
        for (const n of t.nested) add(n, fullName)
      }
    }
    for (const t of file.types) add(t, file.package)
    for (const s of file.services) this.pendingServices.push({ fullName: prefix + s.name, scope: file.package, methods: s.methods })
  }

  /** Resolve os nomes de tipo pendentes (regras de escopo do protobuf). Chamado antes de usar. */
  resolve() {
    if (!this.pending.length && !this.pendingServices.length) return this
    // Os tipos bem conhecidos estão sempre disponíveis, mesmo sem import (ex.: texto colado sem os imports).
    for (const [name, text] of Object.entries(WELL_KNOWN)) if (!this.files.has(name)) this.addProto(text, name)
    const pending = this.pending
    this.pending = []
    for (const p of pending) {
      if (p.kind === 'enum') {
        this.types.set(p.fullName, { kind: 'enum', fullName: p.fullName, values: new Map(p.values), names: new Map(p.values.map(([n, v]) => [v, n])) })
      } else {
        this.types.set(p.fullName, { kind: 'message', fullName: p.fullName, fields: [], byNumber: new Map(), byName: new Map(), syntax: p.syntax })
      }
    }
    for (const p of pending) {
      if (p.kind !== 'message') continue
      const type = /** @type {MessageType} */ (this.types.get(p.fullName))
      for (const raw of p.fields) {
        const base = this.fieldType(raw.typeName, p.scope)
        /** @type {Field} */
        const field = {
          name: raw.name,
          jsonName: raw.jsonName ?? lowerCamel(raw.name),
          number: raw.number,
          repeated: raw.label === 'repeated',
          ...base,
          ...(raw.packed !== undefined && { packed: raw.packed }),
          ...(raw.oneof && { oneof: raw.oneof }),
          ...((raw.proto3Optional || (p.syntax === 'proto2' && raw.label !== 'repeated')) && { optional: true })
        }
        if (raw.mapKey) field.map = { key: raw.mapKey, value: { name: 'value', jsonName: 'value', number: 2, repeated: false, ...base } }
        if (field.packed === undefined && field.repeated && !field.map && (PACKABLE.has(field.type) || field.type === 'enum')) field.packed = p.syntax !== 'proto2'
        type.fields.push(field)
        type.byNumber.set(field.number, field)
        type.byName.set(field.name, field)
        type.byName.set(field.jsonName, field)
      }
    }
    for (const s of this.pendingServices) {
      /** @type {Service} */
      const service = { fullName: s.fullName, methods: new Map() }
      for (const m of s.methods) {
        service.methods.set(m.name, {
          name: m.name,
          input: this.lookup(m.input, s.scope, 'message'),
          output: this.lookup(m.output, s.scope, 'message'),
          clientStreaming: m.clientStreaming,
          serverStreaming: m.serverStreaming
        })
      }
      this.services.set(s.fullName, service)
    }
    this.pendingServices = []
    return this
  }

  /** Registra tipos já com nome completo, vindos de descritores (reflection). @param {PendingType[]} types */
  addResolved(types, services = /** @type {{ fullName: string, scope: string, methods: Method[] }[]} */ ([])) {
    for (const t of types) this.pending.push(t)
    for (const s of services) this.pendingServices.push(s)
  }

  /** @param {string} typeName @param {string} scope @returns {{ type: string, typeName?: string }} */
  fieldType(typeName, scope) {
    if (SCALARS.has(typeName)) return { type: typeName }
    const fullName = this.lookup(typeName, scope)
    const t = this.types.get(fullName)
    return { type: t?.kind === 'enum' ? 'enum' : 'message', typeName: fullName }
  }

  /** Nome completo de um tipo citado dentro de `scope`. @param {string} name @param {string} scope @param {'message'} [kind] */
  lookup(name, scope, kind) {
    if (name.startsWith('.')) {
      const full = name.slice(1)
      if (!this.types.has(full)) throw new ProtoError(`tipo ${full} não encontrado (falta o .proto que o define?)`, 'PROTO_TYPE_NOT_FOUND')
      return full
    }
    const parts = scope ? scope.split('.') : []
    for (let i = parts.length; i >= 0; i--) {
      const candidate = [...parts.slice(0, i), name].join('.')
      const t = this.types.get(candidate)
      if (t && (!kind || t.kind === kind)) return candidate
    }
    throw new ProtoError(`tipo ${name} não encontrado (falta o .proto que o define? Cole os arquivos importados em sequência, cada um começando com syntax)`, 'PROTO_TYPE_NOT_FOUND')
  }

  /** @param {string} fullName @returns {MessageType} */
  message(fullName) {
    const t = this.resolve().types.get(fullName)
    if (!t || t.kind !== 'message') throw new ProtoError(`mensagem ${fullName} não encontrada`, 'PROTO_TYPE_NOT_FOUND')
    return t
  }

  /**
   * Serviço e método pelo nome: o serviço pode vir completo (pkg.Svc) ou só o nome curto, se for único.
   * @param {string} serviceName @param {string} methodName
   */
  method(serviceName, methodName) {
    this.resolve()
    const wanted = serviceName.replace(/^\./, '')
    let service = this.services.get(wanted)
    if (!service) {
      const matches = [...this.services.values()].filter((s) => s.fullName === wanted || s.fullName.endsWith(`.${wanted}`))
      if (matches.length > 1) throw new ProtoError(`o nome ${serviceName} é ambíguo: ${matches.map((s) => s.fullName).join(', ')}`, 'GRPC_SERVICE_NOT_FOUND')
      service = matches[0]
    }
    if (!service) {
      const known = [...this.services.keys()]
      throw new ProtoError(`serviço ${serviceName} não encontrado${known.length ? ` (disponíveis: ${known.join(', ')})` : ''}`, 'GRPC_SERVICE_NOT_FOUND')
    }
    const method = service.methods.get(methodName) ?? [...service.methods.values()].find((m) => m.name.toLowerCase() === methodName.toLowerCase())
    if (!method) {
      throw new ProtoError(`o serviço ${service.fullName} não tem o método ${methodName} (métodos: ${[...service.methods.keys()].join(', ')})`, 'GRPC_METHOD_NOT_FOUND')
    }
    return { service, method }
  }
}

// ---- fio ----

class Writer {
  constructor() {
    /** @type {Buffer[]} */
    this.chunks = []
  }
  /** @param {bigint} v */
  varint(v) {
    let n = BigInt.asUintN(64, v)
    const bytes = []
    while (n > 0x7fn) {
      bytes.push(Number(n & 0x7fn) | 0x80)
      n >>= 7n
    }
    bytes.push(Number(n))
    this.chunks.push(Buffer.from(bytes))
  }
  /** @param {number} number @param {number} wire */
  tag(number, wire) {
    this.varint(BigInt((number << 3) | wire))
  }
  /** @param {Buffer} b */
  bytes(b) {
    this.varint(BigInt(b.length))
    this.chunks.push(b)
  }
  /** @param {Buffer} b */
  raw(b) {
    this.chunks.push(b)
  }
  finish() {
    return Buffer.concat(this.chunks)
  }
}

class Reader {
  /** @param {Buffer} buf */
  constructor(buf) {
    this.buf = buf
    this.pos = 0
  }
  get done() {
    return this.pos >= this.buf.length
  }
  varint() {
    let result = 0n
    let shift = 0n
    for (;;) {
      if (this.pos >= this.buf.length) throw new ProtoError('mensagem protobuf truncada (varint)', 'PROTO_DECODE')
      const b = /** @type {number} */ (this.buf[this.pos++])
      result |= BigInt(b & 0x7f) << shift
      if (!(b & 0x80)) return result
      shift += 7n
      if (shift > 70n) throw new ProtoError('varint inválido', 'PROTO_DECODE')
    }
  }
  /** @param {number} n */
  take(n) {
    if (this.pos + n > this.buf.length) throw new ProtoError('mensagem protobuf truncada', 'PROTO_DECODE')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  lengthDelimited() {
    return this.take(Number(this.varint()))
  }
  /** @param {number} wire */
  skip(wire) {
    if (wire === 0) this.varint()
    else if (wire === 1) this.take(8)
    else if (wire === 2) this.lengthDelimited()
    else if (wire === 5) this.take(4)
    else if (wire === 3) {
      // group antigo: pula até o fim correspondente.
      for (;;) {
        const tag = Number(this.varint())
        if ((tag & 7) === 4) return
        this.skip(tag & 7)
      }
    } else throw new ProtoError(`tipo de fio desconhecido: ${wire}`, 'PROTO_DECODE')
  }
}

// ---- escalares ----

/** @param {unknown} v @param {string} type @param {string} path */
function toBigInt(v, type, path) {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim())
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(Math.trunc(v)) && v === Math.trunc(v)) return BigInt(v)
  throw new ProtoError(`${path}: esperava um inteiro (${type}), veio ${JSON.stringify(v)}`, 'PROTO_ENCODE')
}

/** @param {unknown} v @param {string} path */
function toNumber(v, path) {
  if (typeof v === 'number') return v
  if (v === 'NaN') return NaN
  if (v === 'Infinity') return Infinity
  if (v === '-Infinity') return -Infinity
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  throw new ProtoError(`${path}: esperava um número, veio ${JSON.stringify(v)}`, 'PROTO_ENCODE')
}

/** @param {Writer} w @param {string} type @param {unknown} v @param {string} path */
function writeScalar(w, type, v, path) {
  switch (type) {
    case 'double': {
      const b = Buffer.alloc(8)
      b.writeDoubleLE(toNumber(v, path))
      return w.raw(b)
    }
    case 'float': {
      const b = Buffer.alloc(4)
      b.writeFloatLE(toNumber(v, path))
      return w.raw(b)
    }
    case 'int32':
    case 'int64':
    case 'uint32':
    case 'uint64':
      return w.varint(toBigInt(v, type, path))
    case 'sint32':
    case 'sint64': {
      const n = toBigInt(v, type, path)
      return w.varint(n >= 0n ? n << 1n : (-n << 1n) - 1n)
    }
    case 'bool':
      if (typeof v !== 'boolean' && v !== 'true' && v !== 'false') throw new ProtoError(`${path}: esperava true ou false`, 'PROTO_ENCODE')
      return w.varint(v === true || v === 'true' ? 1n : 0n)
    case 'fixed32':
    case 'sfixed32': {
      const b = Buffer.alloc(4)
      const n = Number(toBigInt(v, type, path))
      if (type === 'fixed32') b.writeUInt32LE(n >>> 0)
      else b.writeInt32LE(n | 0)
      return w.raw(b)
    }
    case 'fixed64':
    case 'sfixed64': {
      const b = Buffer.alloc(8)
      const n = toBigInt(v, type, path)
      if (type === 'fixed64') b.writeBigUInt64LE(BigInt.asUintN(64, n))
      else b.writeBigInt64LE(BigInt.asIntN(64, n))
      return w.raw(b)
    }
    case 'string':
      if (typeof v !== 'string') throw new ProtoError(`${path}: esperava texto, veio ${JSON.stringify(v)}`, 'PROTO_ENCODE')
      return w.bytes(Buffer.from(v, 'utf8'))
    case 'bytes':
      if (typeof v !== 'string') throw new ProtoError(`${path}: bytes vão em base64, veio ${JSON.stringify(v)}`, 'PROTO_ENCODE')
      return w.bytes(Buffer.from(v, 'base64'))
  }
}

/** @param {Reader} r @param {string} type */
function readScalar(r, type) {
  switch (type) {
    case 'double':
      return r.take(8).readDoubleLE(0)
    case 'float':
      return r.take(4).readFloatLE(0)
    case 'int32':
      return Number(BigInt.asIntN(32, r.varint()))
    case 'uint32':
      return Number(BigInt.asUintN(32, r.varint()))
    case 'int64':
      return BigInt.asIntN(64, r.varint())
    case 'uint64':
      return BigInt.asUintN(64, r.varint())
    case 'sint32':
    case 'sint64': {
      const n = r.varint()
      const v = n & 1n ? -((n + 1n) >> 1n) : n >> 1n
      return type === 'sint32' ? Number(v) : v
    }
    case 'bool':
      return r.varint() !== 0n
    case 'fixed32':
      return r.take(4).readUInt32LE(0)
    case 'sfixed32':
      return r.take(4).readInt32LE(0)
    case 'fixed64':
      return r.take(8).readBigUInt64LE(0)
    case 'sfixed64':
      return r.take(8).readBigInt64LE(0)
    case 'string':
      return r.lengthDelimited().toString('utf8')
    case 'bytes':
      return Buffer.from(r.lengthDelimited())
  }
  throw new ProtoError(`tipo escalar desconhecido: ${type}`, 'PROTO_DECODE')
}

// ---- mensagens ----

/** @param {Registry} registry @param {string} typeName @param {unknown} value @param {string} [path] @returns {Buffer} */
function encode(registry, typeName, value, path = typeName) {
  const type = registry.message(typeName)
  const w = new Writer()
  encodeInto(registry, type, toProtoShape(registry, type, value, path), w, path)
  return w.finish()
}

/** @param {Registry} registry @param {MessageType} type @param {unknown} value @param {Writer} w @param {string} path */
function encodeInto(registry, type, value, w, path) {
  if (value === null || value === undefined) return
  if (typeof value !== 'object' || Array.isArray(value)) throw new ProtoError(`${path}: esperava um objeto para ${type.fullName}, veio ${JSON.stringify(value)}`, 'PROTO_ENCODE')
  for (const [key, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue
    const field = type.byName.get(key)
    if (!field) throw new ProtoError(`${path}: ${type.fullName} não tem o campo "${key}" (campos: ${type.fields.map((f) => f.jsonName).join(', ')})`, 'PROTO_ENCODE')
    const fieldPath = `${path}.${key}`
    if (field.map) {
      if (typeof v !== 'object' || Array.isArray(v)) throw new ProtoError(`${fieldPath}: um map vai como objeto`, 'PROTO_ENCODE')
      for (const [k, item] of Object.entries(v)) {
        const entry = new Writer()
        entry.tag(1, WIRE[/** @type {keyof typeof WIRE} */ (field.map.key)])
        writeScalar(entry, field.map.key, field.map.key === 'bool' ? k === 'true' : k, `${fieldPath}.${k}`)
        writeValue(registry, entry, field.map.value, item, `${fieldPath}.${k}`)
        w.tag(field.number, 2)
        w.bytes(entry.finish())
      }
    } else if (field.repeated) {
      if (!Array.isArray(v)) throw new ProtoError(`${fieldPath}: um campo repeated vai como lista`, 'PROTO_ENCODE')
      if (field.packed) {
        const inner = new Writer()
        v.forEach((item, i) => writeBare(registry, inner, field, item, `${fieldPath}[${i}]`))
        w.tag(field.number, 2)
        w.bytes(inner.finish())
      } else v.forEach((item, i) => writeValue(registry, w, field, item, `${fieldPath}[${i}]`))
    } else writeValue(registry, w, field, v, fieldPath)
  }
}

/** Valor com a tag. @param {Registry} registry @param {Writer} w @param {Field} field @param {unknown} v @param {string} path */
function writeValue(registry, w, field, v, path) {
  if (field.type === 'message') {
    const type = registry.message(/** @type {string} */ (field.typeName))
    const inner = new Writer()
    encodeInto(registry, type, toProtoShape(registry, type, v, path), inner, path)
    w.tag(field.number, 2)
    w.bytes(inner.finish())
  } else {
    w.tag(field.number, field.type === 'enum' ? 0 : WIRE[/** @type {keyof typeof WIRE} */ (field.type)])
    writeBare(registry, w, field, v, path)
  }
}

/** Valor sem a tag (escalar ou enum). @param {Registry} registry @param {Writer} w @param {Field} field @param {unknown} v @param {string} path */
function writeBare(registry, w, field, v, path) {
  if (field.type === 'enum') {
    const e = /** @type {EnumType} */ (registry.types.get(/** @type {string} */ (field.typeName)))
    let n
    if (typeof v === 'number') n = v
    else if (typeof v === 'string' && e.values.has(v)) n = e.values.get(v)
    else if (typeof v === 'string' && /^-?\d+$/.test(v)) n = Number(v)
    else throw new ProtoError(`${path}: ${JSON.stringify(v)} não é um valor de ${e.fullName} (${[...e.values.keys()].join(', ')})`, 'PROTO_ENCODE')
    return w.varint(BigInt(/** @type {number} */ (n)))
  }
  writeScalar(w, field.type, v, path)
}

/** @param {Registry} registry @param {string} typeName @param {Buffer} buf @param {{ emitDefaults?: boolean }} [options] */
function decode(registry, typeName, buf, options = {}) {
  return toJson(registry, registry.message(typeName), decodeRaw(registry, registry.message(typeName), buf), options)
}

/**
 * Bytes → objeto com os valores crus (bigint, Buffer, números de enum), por número de campo.
 * @param {Registry} registry @param {MessageType} type @param {Buffer} buf @returns {Map<number, unknown>}
 */
function decodeRaw(registry, type, buf) {
  const r = new Reader(buf)
  /** @type {Map<number, unknown>} */
  const out = new Map()
  while (!r.done) {
    const tag = Number(r.varint())
    const number = tag >>> 3
    const wire = tag & 7
    const field = type.byNumber.get(number)
    if (!field) {
      r.skip(wire)
      continue
    }
    if (field.map) {
      const entry = new Reader(r.lengthDelimited())
      let key = /** @type {unknown} */ (undefined)
      let value = /** @type {unknown} */ (undefined)
      while (!entry.done) {
        const t = Number(entry.varint())
        if (t >>> 3 === 1) key = readScalar(entry, field.map.key)
        else if (t >>> 3 === 2) value = readOne(registry, entry, field.map.value, t & 7)
        else entry.skip(t & 7)
      }
      const map = /** @type {Map<unknown, unknown>} */ (out.get(number) ?? new Map())
      map.set(key ?? defaultScalar(field.map.key, true), value)
      out.set(number, map)
    } else if (field.repeated) {
      const list = /** @type {unknown[]} */ (out.get(number) ?? [])
      if (wire === 2 && field.type !== 'message' && field.type !== 'string' && field.type !== 'bytes') {
        const packed = new Reader(r.lengthDelimited())
        while (!packed.done) list.push(field.type === 'enum' ? Number(BigInt.asIntN(32, packed.varint())) : readScalar(packed, field.type))
      } else list.push(readOne(registry, r, field, wire))
      out.set(number, list)
    } else {
      if (field.oneof) for (const f of type.fields) if (f.oneof === field.oneof && f.number !== number) out.delete(f.number)
      const value = readOne(registry, r, field, wire)
      // Mensagem repetida no fio: as ocorrências se fundem.
      const prev = out.get(number)
      if (field.type === 'message' && prev instanceof Map && value instanceof Map) {
        for (const [k, v] of value) prev.set(k, v)
      } else out.set(number, value)
    }
  }
  return out
}

/** @param {Registry} registry @param {Reader} r @param {Field} field @param {number} wire */
function readOne(registry, r, field, wire) {
  if (field.type === 'message') {
    if (wire !== 2) throw new ProtoError(`campo ${field.name}: tipo de fio ${wire} para uma mensagem`, 'PROTO_DECODE')
    return decodeRaw(registry, registry.message(/** @type {string} */ (field.typeName)), r.lengthDelimited())
  }
  if (field.type === 'enum') return Number(BigInt.asIntN(32, r.varint()))
  return readScalar(r, field.type)
}

/** @param {string} type @param {boolean} [raw] */
function defaultScalar(type, raw = false) {
  if (type === 'string') return ''
  if (type === 'bytes') return raw ? Buffer.alloc(0) : ''
  if (type === 'bool') return false
  if (SIXTY_FOUR.has(type)) return raw ? 0n : '0'
  return 0
}

/** @param {Field} field @param {unknown} v @param {Registry} registry @param {{ emitDefaults?: boolean }} options */
function jsonValue(registry, field, v, options) {
  if (field.type === 'message') return toJson(registry, registry.message(/** @type {string} */ (field.typeName)), /** @type {Map<number, unknown>} */ (v), options)
  if (field.type === 'enum') {
    const e = /** @type {EnumType} */ (registry.types.get(/** @type {string} */ (field.typeName)))
    if (e.fullName === 'google.protobuf.NullValue') return null
    return e.names.get(/** @type {number} */ (v)) ?? v
  }
  if (typeof v === 'bigint') return v.toString()
  if (Buffer.isBuffer(v)) return v.toString('base64')
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v)
  return v
}

/** Mapeamento JSON do proto3. @param {Registry} registry @param {MessageType} type @param {Map<number, unknown>} raw @param {{ emitDefaults?: boolean }} options @returns {unknown} */
function toJson(registry, type, raw, options) {
  const wkt = wellKnownToJson(registry, type, raw, options)
  if (wkt !== undefined) return wkt
  const emit = options.emitDefaults !== false
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const field of type.fields) {
    if (raw.has(field.number)) {
      const v = raw.get(field.number)
      if (field.map) {
        /** @type {Record<string, unknown>} */
        const obj = {}
        for (const [k, item] of /** @type {Map<unknown, unknown>} */ (v)) {
          obj[String(k)] = item === undefined ? (field.map.value.type === 'message' ? {} : defaultScalar(field.map.value.type)) : jsonValue(registry, field.map.value, item, options)
        }
        out[field.jsonName] = obj
      } else if (field.repeated) out[field.jsonName] = /** @type {unknown[]} */ (v).map((item) => jsonValue(registry, field, item, options))
      else out[field.jsonName] = jsonValue(registry, field, v, options)
    } else if (emit && !field.oneof && !field.optional) {
      if (field.map) out[field.jsonName] = {}
      else if (field.repeated) out[field.jsonName] = []
      else if (field.type === 'message') out[field.jsonName] = null
      else if (field.type === 'enum') {
        const e = /** @type {EnumType} */ (registry.types.get(/** @type {string} */ (field.typeName)))
        out[field.jsonName] = e.names.get(0) ?? 0
      } else out[field.jsonName] = defaultScalar(field.type)
    }
  }
  return out
}

/** Fração de segundos do JSON do protobuf: 0, 3, 6 ou 9 dígitos. @param {number} nanos */
function fraction(nanos) {
  if (!nanos) return ''
  const digits = String(Math.abs(nanos)).padStart(9, '0')
  return `.${digits.endsWith('000000') ? digits.slice(0, 3) : digits.endsWith('000') ? digits.slice(0, 6) : digits}`
}

/** @param {Registry} registry @param {MessageType} type @param {Map<number, unknown>} raw @param {{ emitDefaults?: boolean }} options */
function wellKnownToJson(registry, type, raw, options) {
  const get = (/** @type {number} */ n, /** @type {unknown} */ d) => (raw.has(n) ? raw.get(n) : d)
  switch (type.fullName) {
    case 'google.protobuf.Timestamp': {
      const seconds = /** @type {bigint} */ (get(1, 0n))
      const nanos = /** @type {number} */ (get(2, 0))
      const iso = new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, '')
      return `${iso}${fraction(nanos)}Z`
    }
    case 'google.protobuf.Duration': {
      const seconds = /** @type {bigint} */ (get(1, 0n))
      const nanos = /** @type {number} */ (get(2, 0))
      const negative = seconds < 0n || nanos < 0
      const abs = seconds < 0n ? -seconds : seconds
      return `${negative ? '-' : ''}${abs}${fraction(nanos)}s`
    }
    case 'google.protobuf.Empty':
      return {}
    case 'google.protobuf.FieldMask':
      return /** @type {string[]} */ (get(1, [])).map(lowerCamel).join(',')
    case 'google.protobuf.Struct': {
      /** @type {Record<string, unknown>} */
      const obj = {}
      for (const [k, v] of /** @type {Map<string, Map<number, unknown>>} */ (get(1, new Map()))) obj[k] = v ? toJson(registry, registry.message('google.protobuf.Value'), v, options) : null
      return obj
    }
    case 'google.protobuf.ListValue':
      return /** @type {Map<number, unknown>[]} */ (get(1, [])).map((v) => toJson(registry, registry.message('google.protobuf.Value'), v, options))
    case 'google.protobuf.Value': {
      if (raw.has(2)) return jsonValue(registry, /** @type {Field} */ (type.byNumber.get(2)), raw.get(2), options)
      if (raw.has(3)) return raw.get(3)
      if (raw.has(4)) return raw.get(4)
      if (raw.has(5)) return toJson(registry, registry.message('google.protobuf.Struct'), /** @type {Map<number, unknown>} */ (raw.get(5)), options)
      if (raw.has(6)) return toJson(registry, registry.message('google.protobuf.ListValue'), /** @type {Map<number, unknown>} */ (raw.get(6)), options)
      return null
    }
    case 'google.protobuf.Any': {
      const url = /** @type {string} */ (get(1, ''))
      const value = /** @type {Buffer} */ (get(2, Buffer.alloc(0)))
      const name = url.slice(url.lastIndexOf('/') + 1)
      const inner = registry.types.get(name)
      if (!inner || inner.kind !== 'message') return { '@type': url, value: value.toString('base64') }
      const decoded = toJson(registry, inner, decodeRaw(registry, inner, value), options)
      return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? { '@type': url, ...decoded } : { '@type': url, value: decoded }
    }
  }
  if (WRAPPERS.has(type.fullName)) {
    const field = /** @type {Field} */ (type.byNumber.get(1))
    return raw.has(1) ? jsonValue(registry, field, raw.get(1), options) : defaultScalar(field.type)
  }
  return undefined
}

/**
 * JSON → forma do protobuf para os tipos bem conhecidos (o resto passa direto).
 * @param {Registry} registry @param {MessageType} type @param {unknown} v @param {string} path @returns {unknown}
 */
function toProtoShape(registry, type, v, path) {
  switch (type.fullName) {
    case 'google.protobuf.Timestamp':
      if (typeof v === 'string') {
        const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i.exec(v.trim())
        if (!m) throw new ProtoError(`${path}: Timestamp em RFC 3339 (ex.: 2024-01-02T03:04:05Z), veio ${JSON.stringify(v)}`, 'PROTO_ENCODE')
        const ms = Date.parse(`${m[1]}${m[3]}`)
        return { seconds: String(Math.floor(ms / 1000)), nanos: m[2] ? Number(m[2].slice(1).padEnd(9, '0')) : 0 }
      }
      return v
    case 'google.protobuf.Duration':
      if (typeof v === 'string') {
        const m = /^(-)?(\d+)(\.\d{1,9})?s$/.exec(v.trim())
        if (!m) throw new ProtoError(`${path}: Duration como "1.5s", veio ${JSON.stringify(v)}`, 'PROTO_ENCODE')
        const sign = m[1] ? -1 : 1
        return { seconds: `${m[1] ?? ''}${m[2]}`, nanos: m[3] ? sign * Number(m[3].slice(1).padEnd(9, '0')) : 0 }
      }
      return v
    case 'google.protobuf.FieldMask':
      if (typeof v === 'string') return { paths: v.split(',').filter(Boolean).map((p) => p.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)) }
      return v
    // Cada nível converte só o próprio JSON; o Value de dentro converte o resto.
    case 'google.protobuf.Struct':
      if (v && typeof v === 'object' && !Array.isArray(v)) return { fields: v }
      return v
    case 'google.protobuf.ListValue':
      if (Array.isArray(v)) return { values: v }
      return v
    case 'google.protobuf.Value':
      if (v === null || v === undefined) return { nullValue: 0 }
      if (typeof v === 'number') return { numberValue: v }
      if (typeof v === 'string') return { stringValue: v }
      if (typeof v === 'boolean') return { boolValue: v }
      if (Array.isArray(v)) return { listValue: v }
      return { structValue: v }
    case 'google.protobuf.Any':
      if (v && typeof v === 'object' && '@type' in v) {
        const { '@type': url, ...rest } = /** @type {Record<string, unknown>} */ (v)
        const name = String(url).slice(String(url).lastIndexOf('/') + 1)
        const inner = registry.message(name)
        const body = 'value' in rest && Object.keys(rest).length === 1 && (inner.fullName.startsWith('google.protobuf.')) ? rest['value'] : rest
        return { typeUrl: url, value: encode(registry, inner.fullName, body, path).toString('base64') }
      }
      return v
  }
  if (WRAPPERS.has(type.fullName) && (v === null || typeof v !== 'object')) return { value: v }
  return v
}

module.exports = { Registry, ProtoError, encode, decode, decodeRaw, Writer, Reader, lowerCamel, WELL_KNOWN }
