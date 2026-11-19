// @ts-check
'use strict'

/**
 * Server reflection do gRPC (grpc.reflection.v1, com volta para v1alpha): pede o arquivo
 * que define o serviço e, rodada a rodada, as dependências que faltarem.
 */

const { Registry, encode, decode } = require('./protobuf')
const { addFileDescriptor, decodeFileDescriptor } = require('./descriptor')
const { call, GrpcError } = require('./transport')

const REFLECTION_PROTO = `
syntax = "proto3";
package grpc.reflection.v1;
service ServerReflection { rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse); }
message ServerReflectionRequest {
  string host = 1;
  oneof message_request { string file_by_filename = 3; string file_containing_symbol = 4; string list_services = 7; }
}
message ServerReflectionResponse {
  string valid_host = 1;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`
const protocol = new Registry().addProto(REFLECTION_PROTO, 'reflection.proto')
const REQUEST = 'grpc.reflection.v1.ServerReflectionRequest'
const RESPONSE = 'grpc.reflection.v1.ServerReflectionResponse'
const VERSIONS = ['grpc.reflection.v1', 'grpc.reflection.v1alpha']

/**
 * @param {{ url: string, metadata?: Record<string, string>, timeoutMs: number, signal?: AbortSignal, tls?: import('./transport').TlsMaterial }} target
 * @param {object[]} requests
 * @returns {Promise<any[]>}
 */
async function ask(target, requests, version = VERSIONS[0]) {
  const result = await call({
    ...target,
    path: `/${version}.ServerReflection/ServerReflectionInfo`,
    messages: requests.map((r) => encode(protocol, REQUEST, r))
  })
  if (result.status !== 0) {
    throw new GrpcError(`reflection: ${result.statusName}${result.message ? ` (${result.message})` : ''}`, result.status === 12 ? 'REFLECTION_UNIMPLEMENTED' : 'REFLECTION_FAILED')
  }
  return result.messages.map((m) => decode(protocol, RESPONSE, m, { emitDefaults: false }))
}

/**
 * Registry com o serviço `symbol` e tudo de que ele depende, lido do servidor.
 * @param {Parameters<typeof ask>[0]} target @param {string} symbol @param {(msg: string) => void} [log]
 */
async function loadByReflection(target, symbol, log = () => {}) {
  let version = VERSIONS[0]
  const registry = new Registry()
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {object[]} */
  let requests = [{ fileContainingSymbol: symbol }]
  let rounds = 0
  while (requests.length) {
    if (++rounds > 20) throw new GrpcError('reflection: dependências demais', 'REFLECTION_FAILED')
    let responses
    try {
      responses = await ask(target, requests, version)
    } catch (err) {
      if (/** @type {any} */ (err).code === 'REFLECTION_UNIMPLEMENTED' && version === VERSIONS[0]) {
        version = VERSIONS[1]
        responses = await ask(target, requests, version)
      } else throw err
    }
    /** @type {string[]} */
    const deps = []
    for (const r of responses) {
      if (r.errorResponse) {
        const what = /** @type {any} */ (requests[0]).fileContainingSymbol ?? 'o arquivo pedido'
        throw new GrpcError(`reflection: ${r.errorResponse.errorMessage || `erro ${r.errorResponse.errorCode}`} (${what})`, 'GRPC_SERVICE_NOT_FOUND')
      }
      for (const b64 of r.fileDescriptorResponse?.fileDescriptorProto ?? []) {
        const file = decodeFileDescriptor(Buffer.from(b64, 'base64'))
        if (!file.name || seen.has(file.name)) continue
        seen.add(file.name)
        addFileDescriptor(registry, file)
        deps.push(...(file.dependency ?? []))
      }
    }
    requests = [...new Set(deps)].filter((d) => !seen.has(d) && !d.startsWith('google/protobuf/')).map((d) => ({ fileByFilename: d }))
  }
  log(`reflection (${version}): ${seen.size} arquivo(s) .proto`)
  return registry
}

/** Nomes dos serviços expostos (para a mensagem de erro de um serviço que não existe). @param {Parameters<typeof ask>[0]} target */
async function listServices(target) {
  for (const version of VERSIONS) {
    try {
      const [r] = await ask(target, [{ listServices: '*' }], version)
      return (r?.listServicesResponse?.service ?? []).map((/** @type {any} */ s) => s.name)
    } catch (err) {
      if (/** @type {any} */ (err).code !== 'REFLECTION_UNIMPLEMENTED') throw err
    }
  }
  return []
}

module.exports = { loadByReflection, listServices, REFLECTION_PROTO }
