#!/usr/bin/env node
// API de mentira do projeto de demonstração (examples/demo-workspace): OAuth2 client
// credentials, cobranças, clientes, estornos e o checkout do fluxo. Só em loopback.
// Uso: node scripts/demo-server.mjs [porta]   (padrão 4010)
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? process.env.PORT ?? 4010)
const TOKEN = 'demo-access-token'

export function demoServer() {
  return createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://demo')
      const reply = (status, data, headers = {}) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          'set-cookie': 'demo_session=abc123; Path=/; HttpOnly',
          ...headers
        })
        res.end(JSON.stringify(data, null, 2))
      }
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        if (!raw.includes('=')) return reply(400, { error: 'INVALID_JSON' })
      }
      const path = url.pathname
      if (path === '/oauth/token') {
        const form = new URLSearchParams(raw)
        // O segredo chega no corpo ou, o padrão do VVPost, em Basic (RFC 6749, 2.3.1).
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1]
        const secret = basic ? decodeURIComponent(Buffer.from(basic, 'base64').toString().split(':')[1] ?? '') : form.get('client_secret')
        if (secret !== 'demo-secret') return reply(401, { error: 'invalid_client' })
        return reply(200, { access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 })
      }
      if (path === '/auth/login') return reply(200, { token: TOKEN, cartId: 'cart_42' })
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: 'unauthorized' })
      if (path === '/payments/v1/charges' && req.method === 'POST') {
        if (!(body.amount > 0)) return reply(400, { error: 'INVALID_AMOUNT', message: 'amount deve ser positivo' })
        if (body.amount > 10000) return reply(402, { error: 'CARD_DECLINED', status: 'declined' })
        const now = new Date().toISOString()
        return reply(201, {
          id: 'ch_7f3a9e2c4b6d',
          status: 'approved',
          amount: body.amount,
          currency: body.currency ?? 'BRL',
          customer_id: body.customer_id,
          created_at: now,
          updated_at: now,
          gateway: 'stripe',
          metadata: { order_id: 'ord_9987' }
        })
      }
      if (path.startsWith('/payments/v1/charges/'))
        return reply(200, { id: path.split('/').pop(), status: 'approved', amount: 150 })
      if (path === '/payments/v1/refunds')
        return reply(200, {
          items: [{ id: 'rf_1', amount: 20, status: url.searchParams.get('status') }],
          limit: Number(url.searchParams.get('limit') ?? 20)
        })
      if (path === '/customers/v2/me') return reply(200, { id: 'cust_123', name: 'Ana Lima', email: 'ana@example.com' })
      if (path === '/customers/v2/' || path === '/customers/v2')
        return reply(200, { page: 1, items: [{ id: 'cust_123', name: 'Ana Lima' }] })
      if (path.startsWith('/carts/'))
        return reply(200, {
          id: path.split('/').pop(),
          count: 2,
          total: 159.9,
          items: [
            { sku: 'A1', price: 99.9 },
            { sku: 'B2', price: 60 }
          ]
        })
      reply(404, { error: 'NOT_FOUND', path })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demoServer().listen(port, '127.0.0.1', () => console.log(`API de demonstração em http://127.0.0.1:${port}`))
}
