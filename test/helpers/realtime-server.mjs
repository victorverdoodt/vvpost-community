// Servidor de teste de WebSocket, Socket.IO (Engine.IO v4) e SSE, sem dependências: o handshake
// do RFC 6455 e os frames de texto à mão. Usado pelos testes do core e pelo e2e do Quick Request.
//   /ws          manda {"hello":true,"authorization":...} ao abrir e responde "echo:<texto>"
//   /ws-401      recusa o upgrade com 401
//   /socket.io/  namespaces / e /admin: "welcome" ao conectar e "echo" para todo evento; manda ping
//   /sse         três eventos (um com event:, um de várias linhas com id:, um com o Authorization) e fecha
//   /sse-post    POST: devolve o corpo num evento e fecha
//   /sse-json    responde JSON (não é event stream)
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function frame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const len = data.length
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b })()])
  return Buffer.concat([head, data])
}

/** Lê os frames (mascarados) do cliente; chama onFrame(opcode, payload). */
function reader(onFrame) {
  let buf = Buffer.alloc(0)
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 2) return
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let at = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        at = 10
      }
      const mask = masked ? buf.subarray(at, at + 4) : null
      if (masked) at += 4
      if (buf.length < at + len) return
      const payload = Buffer.from(buf.subarray(at, at + len))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      buf = buf.subarray(at + len)
      onFrame(opcode, payload)
    }
  }
}

export async function startRealtimeServer() {
  /** @type {{ headers: import('node:http').IncomingHttpHeaders[], pongs: number, received: string[] }} */
  const state = { headers: [], pongs: 0, received: [] }
  const sockets = new Set()
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    state.headers.push(req.headers)
    if (url.pathname === '/sse-json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"ok":true}')
    }
    if (url.pathname === '/sse' || url.pathname === '/api/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(': comentário do servidor\n\n')
      res.write('event: tick\ndata: 1\n\n')
      res.write('data: linha1\r\ndata: linha2\r\nid: 7\r\n\r\n')
      res.write(`data: ${JSON.stringify({ authorization: req.headers.authorization ?? null })}\n\n`)
      return setTimeout(() => res.end(), 20)
    }
    if (url.pathname === '/sse-post') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`event: eco\ndata: ${req.method} ${body}\n\n`)
        res.end()
      })
      return
    }
    res.writeHead(404).end()
  })
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    state.headers.push(req.headers)
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/ws-401') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${GUID}`).digest('base64')
    const protocol = String(req.headers['sec-websocket-protocol'] ?? '').split(',')[0]?.trim()
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`
    )
    const text = (s) => socket.write(frame(0x1, s))
    const io = url.pathname.startsWith('/socket.io')
    const close = (code = 1000) => {
      const b = Buffer.alloc(2)
      b.writeUInt16BE(code)
      socket.end(frame(0x8, b))
    }
    socket.on(
      'data',
      reader((opcode, payload) => {
        if (opcode === 0x8) return close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000)
        if (opcode === 0x9) return socket.write(frame(0xa, payload))
        if (opcode === 0x2) return socket.write(frame(0x2, payload))
        if (opcode !== 0x1) return
        const msg = payload.toString('utf8')
        state.received.push(msg)
        if (!io) return text(`echo:${msg}`)
        if (msg === '3') return void state.pongs++
        const connect = /^40(\/[^,]*)?,?/.exec(msg)
        if (connect) {
          const ns = connect[1] ?? ''
          const prefix = ns ? `${ns},` : ''
          if (ns === '/proibido') return text(`44${prefix}{"message":"sem permissão"}`)
          text(`40${prefix}{"sid":"s-${ns || 'root'}"}`)
          text(`42${prefix}${JSON.stringify(['welcome', { authorization: req.headers.authorization ?? null }])}`)
          text('2')
          return
        }
        const event = /^42(\/[^,]*,)?(\d*)(.*)$/.exec(msg)
        if (event) {
          const [name, ...args] = JSON.parse(event[3])
          if (name === 'tchau') return text(`41${event[1] ?? ''}`)
          text(`42${event[1] ?? ''}${JSON.stringify(['echo', { name, args }])}`)
        }
      })
    )
    if (io) text('0{"sid":"engine-1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}')
    else text(JSON.stringify({ hello: true, authorization: req.headers.authorization ?? null, protocol: protocol || null }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy()
        server.closeAllConnections()
        server.close(() => r(undefined))
      })
  }
}
