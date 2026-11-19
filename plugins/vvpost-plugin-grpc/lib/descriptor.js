// @ts-check
'use strict'

/**
 * FileDescriptorProto (o que o server reflection devolve) → tipos do Registry. O próprio
 * descriptor.proto é lido pelo mesmo parser, só com os campos que importam.
 */

const { Registry, decode } = require('./protobuf')

const DESCRIPTOR_PROTO = `
syntax = "proto2";
package google.protobuf;
message FileDescriptorProto {
  optional string name = 1; optional string package = 2; repeated string dependency = 3;
  repeated DescriptorProto message_type = 4; repeated EnumDescriptorProto enum_type = 5;
  repeated ServiceDescriptorProto service = 6; optional string syntax = 12; optional string edition_name = 13;
}
message DescriptorProto {
  optional string name = 1; repeated FieldDescriptorProto field = 2; repeated DescriptorProto nested_type = 3;
  repeated EnumDescriptorProto enum_type = 4; repeated OneofDescriptorProto oneof_decl = 8; optional MessageOptions options = 7;
}
message MessageOptions { optional bool map_entry = 7; }
message FieldDescriptorProto {
  optional string name = 1; optional int32 number = 3; optional int32 label = 4; optional int32 type = 5;
  optional string type_name = 6; optional string json_name = 10; optional int32 oneof_index = 9;
  optional FieldOptions options = 8; optional bool proto3_optional = 17;
}
message FieldOptions { optional bool packed = 2; }
message OneofDescriptorProto { optional string name = 1; }
message EnumDescriptorProto { optional string name = 1; repeated EnumValueDescriptorProto value = 2; }
message EnumValueDescriptorProto { optional string name = 1; optional int32 number = 2; }
message ServiceDescriptorProto { optional string name = 1; repeated MethodDescriptorProto method = 2; }
message MethodDescriptorProto {
  optional string name = 1; optional string input_type = 2; optional string output_type = 3;
  optional bool client_streaming = 5; optional bool server_streaming = 6;
}
`

const descriptors = new Registry().addProto(DESCRIPTOR_PROTO, 'google/protobuf/descriptor.proto')

/** Tipo do FieldDescriptorProto.Type → nome do escalar (11 mensagem, 14 enum, 10 group). */
const TYPES = /** @type {Record<number, string>} */ ({
  1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 6: 'fixed64', 7: 'fixed32', 8: 'bool',
  9: 'string', 12: 'bytes', 13: 'uint32', 15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64'
})

/**
 * @typedef {{ name?: string, package?: string, dependency?: string[], messageType?: any[], enumType?: any[],
 *   service?: any[], syntax?: string, editionName?: string }} FileDescriptor
 */

/** @param {Buffer} bytes @returns {FileDescriptor} */
function decodeFileDescriptor(bytes) {
  return /** @type {FileDescriptor} */ (decode(descriptors, 'google.protobuf.FileDescriptorProto', bytes, { emitDefaults: false }))
}

/**
 * Acrescenta um arquivo decodificado ao registry (os nomes de tipo nos descritores já são
 * absolutos, ".pkg.Msg"). Campos map viram map<k, v> pela mensagem com map_entry.
 * @param {Registry} registry @param {FileDescriptor} file
 */
function addFileDescriptor(registry, file) {
  const name = file.name ?? `reflection-${registry.files.size}`
  if (registry.files.has(name)) return
  registry.files.add(name)
  const syntax = file.syntax || (file.editionName ? 'editions' : 'proto2')
  const pkg = file.package ?? ''
  /** @type {import('./protobuf').PendingType[]} */
  const types = []
  /** @type {Map<string, any>} */
  const mapEntries = new Map()
  /** @param {any} m @param {string} scope */
  const collectMaps = (m, scope) => {
    const fullName = scope ? `${scope}.${m.name}` : m.name
    if (m.options?.mapEntry) mapEntries.set(fullName, m)
    for (const n of m.nestedType ?? []) collectMaps(n, fullName)
  }
  for (const m of file.messageType ?? []) collectMaps(m, pkg)
  // Nomes de tipo relativos (alguns servidores, como o grpc-js, não os escrevem com o "." absoluto).
  /** @param {string} typeName @param {string} scope */
  const findEntry = (typeName, scope) => {
    if (typeName.startsWith('.')) return mapEntries.get(typeName.slice(1))
    const parts = scope.split('.')
    for (let i = parts.length; i >= 0; i--) {
      const hit = mapEntries.get([...parts.slice(0, i), typeName].join('.'))
      if (hit) return hit
    }
    return undefined
  }
  /** @param {any} e @param {string} scope */
  const addEnum = (e, scope) =>
    types.push({ kind: 'enum', fullName: scope ? `${scope}.${e.name}` : e.name, values: (e.value ?? []).map((/** @type {any} */ v) => [v.name, v.number ?? 0]) })
  /** @param {any} m @param {string} scope */
  const addMessage = (m, scope) => {
    const fullName = scope ? `${scope}.${m.name}` : m.name
    if (mapEntries.has(fullName)) return
    const oneofs = (m.oneofDecl ?? []).map((/** @type {any} */ o) => o.name)
    // proto3 optional vira um oneof sintético "_campo" com um campo só (às vezes sem proto3_optional marcado).
    /** @param {any} f */
    const synthetic = (f) =>
      f.proto3Optional || (f.oneofIndex !== undefined && oneofs[f.oneofIndex] === `_${f.name}` && (m.field ?? []).filter((/** @type {any} */ x) => x.oneofIndex === f.oneofIndex).length === 1)
    types.push({
      kind: 'message',
      fullName,
      scope: fullName,
      syntax,
      fields: (m.field ?? []).map((/** @type {any} */ f) => {
        const typeName = TYPES[f.type] ?? f.typeName
        const entry = f.typeName && f.label === 3 ? findEntry(f.typeName, fullName) : undefined
        const optional = synthetic(f)
        const oneof = f.oneofIndex !== undefined && !optional ? oneofs[f.oneofIndex] : undefined
        if (f.type === 10) throw new Error(`campo ${f.name}: groups do proto2 não são suportados`)
        if (entry) {
          const key = entry.field.find((/** @type {any} */ x) => x.number === 1)
          const value = entry.field.find((/** @type {any} */ x) => x.number === 2)
          return { name: f.name, number: f.number, label: 'repeated', typeName: TYPES[value.type] ?? value.typeName, mapKey: TYPES[key.type], ...(f.jsonName && { jsonName: f.jsonName }) }
        }
        return {
          name: f.name,
          number: f.number,
          label: f.label === 3 ? 'repeated' : f.label === 2 ? 'required' : syntax === 'proto2' || optional ? 'optional' : undefined,
          typeName,
          ...(f.jsonName && { jsonName: f.jsonName }),
          ...(oneof && { oneof }),
          ...(f.options?.packed !== undefined && { packed: f.options.packed }),
          ...(optional && { proto3Optional: true })
        }
      })
    })
    for (const n of m.nestedType ?? []) addMessage(n, fullName)
    for (const e of m.enumType ?? []) addEnum(e, fullName)
  }
  for (const m of file.messageType ?? []) addMessage(m, pkg)
  for (const e of file.enumType ?? []) addEnum(e, pkg)
  const services = (file.service ?? []).map((/** @type {any} */ s) => ({
    fullName: pkg ? `${pkg}.${s.name}` : s.name,
    scope: pkg,
    methods: (s.method ?? []).map((/** @type {any} */ m) => ({
      name: m.name,
      input: m.inputType,
      output: m.outputType,
      clientStreaming: !!m.clientStreaming,
      serverStreaming: !!m.serverStreaming
    }))
  }))
  registry.addResolved(types, services)
}

module.exports = { decodeFileDescriptor, addFileDescriptor, descriptors }
