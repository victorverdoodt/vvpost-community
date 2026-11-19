/**
 * Socket.IO 3+ (Engine.IO v4) sobre WebSocket, sem o cliente oficial: o bastante para conectar
 * num namespace, responder ao ping e trocar eventos. Cada frame do WebSocket é um pacote do
 * Engine.IO (0 open, 1 close, 2 ping, 3 pong, 4 message); a mensagem leva o pacote do
 * Socket.IO (0 CONNECT, 1 DISCONNECT, 2 EVENT, 3 ACK, 4 CONNECT_ERROR) com o namespace e o JSON.
 */

/** A URL do transporte WebSocket e o namespace, como em `io("https://host/admin")`. */
export function socketIoTarget(httpUrl: string): { url: string; namespace: string } {
  const url = new URL(httpUrl)
  let namespace = '/'
  // Um caminho com /socket.io é o do servidor; os outros são o namespace, no caminho padrão.
  if (!/\/socket\.io(\/|$)/.test(url.pathname)) {
    namespace = url.pathname.replace(/\/+$/, '') || '/'
    url.pathname = '/socket.io/'
  } else if (!url.pathname.endsWith('/')) url.pathname += '/'
  url.searchParams.set('EIO', '4')
  url.searchParams.set('transport', 'websocket')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return { url: url.toString(), namespace }
}

const nsPrefix = (namespace: string) => (namespace === '/' ? '' : `${namespace},`)

/** O frame de conexão no namespace, com o payload de auth do handshake quando houver. */
export const connectFrame = (namespace: string, auth?: unknown) => `40${nsPrefix(namespace)}${auth === undefined ? '' : JSON.stringify(auth)}`

/** O frame de um evento: `42/ns,["evento",...args]`. */
export const eventFrame = (namespace: string, event: string, args: unknown[]) => `42${nsPrefix(namespace)}${JSON.stringify([event, ...args])}`

export type SocketIoPacket =
  | { kind: 'open'; sid?: string; pingInterval?: number }
  | { kind: 'ping' }
  | { kind: 'close' }
  | { kind: 'connect'; namespace: string; sid?: string }
  | { kind: 'disconnect'; namespace: string }
  | { kind: 'event'; namespace: string; event: string; args: unknown[]; ackId?: number }
  | { kind: 'ack'; namespace: string; args: unknown[]; ackId?: number }
  | { kind: 'connect_error'; namespace: string; message: string }
  | { kind: 'unsupported'; raw: string }

/** Lê um frame de texto do Engine.IO. Pacotes binários (5 e 6) do Socket.IO não são suportados. */
export function decodeFrame(frame: string): SocketIoPacket {
  const engine = frame[0]
  if (engine === '0') {
    const open = safeJson(frame.slice(1)) as { sid?: unknown; pingInterval?: unknown } | undefined
    return { kind: 'open', ...(typeof open?.sid === 'string' && { sid: open.sid }), ...(typeof open?.pingInterval === 'number' && { pingInterval: open.pingInterval }) }
  }
  if (engine === '1') return { kind: 'close' }
  if (engine === '2') return { kind: 'ping' }
  if (engine !== '4') return { kind: 'unsupported', raw: frame }
  const type = frame[1]
  let rest = frame.slice(2)
  let namespace = '/'
  if (rest.startsWith('/')) {
    const comma = rest.indexOf(',')
    namespace = comma < 0 ? rest : rest.slice(0, comma)
    rest = comma < 0 ? '' : rest.slice(comma + 1)
  }
  const digits = /^\d+/.exec(rest)?.[0]
  const ackId = digits ? Number(digits) : undefined
  if (digits) rest = rest.slice(digits.length)
  const payload = rest ? safeJson(rest) : undefined
  switch (type) {
    case '0':
      return { kind: 'connect', namespace, ...(typeof (payload as { sid?: unknown })?.sid === 'string' && { sid: (payload as { sid: string }).sid }) }
    case '1':
      return { kind: 'disconnect', namespace }
    case '2': {
      const [event, ...args] = Array.isArray(payload) ? payload : []
      return { kind: 'event', namespace, event: String(event ?? ''), args, ...(ackId !== undefined && { ackId }) }
    }
    case '3':
      return { kind: 'ack', namespace, args: Array.isArray(payload) ? payload : [], ...(ackId !== undefined && { ackId }) }
    case '4': {
      const message = (payload as { message?: unknown })?.message
      return { kind: 'connect_error', namespace, message: typeof message === 'string' ? message : JSON.stringify(payload ?? null) }
    }
    default:
      return { kind: 'unsupported', raw: frame }
  }
}

/** Os argumentos de um evento digitado: o texto JSON é um argumento; texto que não é JSON vai como string. */
export function eventArgs(text: string): unknown[] {
  if (!text.trim()) return []
  const parsed = safeJson(text)
  return [parsed === undefined ? text : parsed]
}

/** Os argumentos recebidos como texto: um argumento sozinho fica sem o array em volta. */
export const argsText = (args: unknown[]) => (args.length === 1 ? (typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0])) : JSON.stringify(args))

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
