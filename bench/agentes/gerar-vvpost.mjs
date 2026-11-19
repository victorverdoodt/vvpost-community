// Gera o catálogo da variante com o VVPost (vvpost/api/flows e schemas) a partir das mesmas specs do baseline,
// pelo importador do VVPost, para que as duas variantes descrevam exatamente a mesma API.
//   npm run build && node bench/agentes/gerar-vvpost.mjs
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AQUI = dirname(fileURLToPath(import.meta.url))
const CLI = join(resolve(AQUI, '../..'), 'out/main/cli.js')
const ws = mkdtempSync(join(tmpdir(), 'vvpost-gerar-'))
const specs = ['loja', 'transnorte', 'entregaja'].map((n) => join(AQUI, 'baseline/openapi', `${n}.yaml`))
const r = spawnSync(process.execPath, [CLI, 'import', ...specs, '--workspace', ws], { encoding: 'utf8', env: { ...process.env, VVPOST_VAULT_DIR: join(ws, '.cofre') } })
if (r.status !== 0) throw new Error(r.stdout + r.stderr)

for (const dir of readdirSync(join(ws, 'flows'))) {
  for (const f of readdirSync(join(ws, 'flows', dir))) {
    const p = join(ws, 'flows', dir, f)
    const flow = JSON.parse(readFileSync(p, 'utf8'))
    // A spec não fica no repositório da variante: o catálogo é a fonte.
    delete flow.source
    // A Loja aponta para o ambiente (homologação ou produção), como um projeto de verdade.
    if (flow.id === 'loja-api') {
      flow.defaults.baseUrl = '{{LOJA_URL}}'
      flow.defaults.auth.value = '{{LOJA_API_KEY}}'
    }
    writeFileSync(p, JSON.stringify(flow, null, 2) + '\n')
  }
}
// Os fluxos e os schemas compartilhados que eles citam com schema:<Nome>.
for (const pasta of ['flows', 'schemas']) {
  const destino = join(AQUI, 'vvpost/api', pasta)
  rmSync(destino, { recursive: true, force: true })
  if (existsSync(join(ws, pasta))) cpSync(join(ws, pasta), destino, { recursive: true })
}
rmSync(ws, { recursive: true, force: true })
console.log(`catálogo gerado em ${join(AQUI, 'vvpost/api')}`)
