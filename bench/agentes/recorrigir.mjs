// Corrige de novo as rodadas de uma pasta de resultados, sem rodar o agente: remonta o repositório
// de cada rodada (variante + diff.patch gravado) e aplica o corrigir.mjs atual. Serve para quando
// um critério ou o aceite oculto muda; a mudança fica no histórico do Git do benchmark.
//   node bench/agentes/recorrigir.mjs bench/agentes/resultados/<data>
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { corrigir } from './corrigir.mjs'
import { preparar, respostaFinal } from './rodar.mjs'

const saida = resolve(process.argv[2])
const linhas = []
for (const nome of readdirSync(join(saida, 'rodadas')).sort()) {
  const pasta = join(saida, 'rodadas', nome)
  const r = JSON.parse(readFileSync(join(pasta, 'resultado.json'), 'utf8'))
  const base = mkdtempSync(join(tmpdir(), 'vvpost-recorrigir-'))
  const repo = preparar(r.variante, join(base, 'loja-api'), { porta: r.homolog?.porta, chave: r.homolog?.chave })
  const diff = join(pasta, 'diff.patch')
  const ap = spawnSync('git', ['apply', '--whitespace=nowarn', diff], { cwd: repo, encoding: 'utf8' })
  if (ap.status !== 0 && readFileSync(diff, 'utf8').trim()) throw new Error(`${nome}: git apply falhou: ${ap.stderr}`)
  const transcricao = readFileSync(join(pasta, 'transcricao.jsonl'), 'utf8')
  r.resposta = respostaFinal(transcricao.split('\n').filter(Boolean))
  r.qualidade = corrigir(r.tarefa, r.variante, repo, { esperado: r.homolog?.esperado, resposta: r.resposta, chave: r.homolog?.chave, transcricao })
  rmSync(base, { recursive: true, force: true })
  writeFileSync(join(pasta, 'resultado.json'), JSON.stringify(r, null, 2))
  linhas.push(r)
  console.log(`${nome}: qualidade ${r.qualidade.nota.toFixed(2)}${r.qualidade.ok ? ' ✓' : ''}`)
}
linhas.sort((a, b) => a.inicio.localeCompare(b.inicio))
writeFileSync(join(saida, 'rodadas.jsonl'), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n')
