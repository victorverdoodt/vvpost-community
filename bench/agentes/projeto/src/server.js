import { createServer } from 'node:http'
import { criarApp } from './app.js'

const app = criarApp()
const porta = Number(process.env.PORT ?? 3000)

createServer(async (req, res) => {
  let texto = ''
  for await (const parte of req) texto += parte
  let corpo
  try {
    corpo = texto ? JSON.parse(texto) : undefined
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ erro: { codigo: 'JSON_INVALIDO', mensagem: 'Corpo não é JSON' } }))
  }
  const { status, body } = await app.handle(req.method, req.url, corpo)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}).listen(porta, () => console.log(`loja-api em http://localhost:${porta}`))
