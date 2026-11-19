// Resume as rodadas de uma pasta de resultados em resumo.md e resumo.json.
//   node bench/agentes/resumir.mjs bench/agentes/resultados/<data>
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const saida = resolve(process.argv[2])
const rodadas = readFileSync(join(saida, 'rodadas.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

const media = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const dp = (xs) => {
  const m = media(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1))
}
const mediana = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

// Intervalo de 95% da diferença das médias (vvpost − baseline) por bootstrap, com semente fixa
// para o resumo sair igual a cada vez.
function bootstrap(a, b, n = 10_000) {
  let s = 42
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
  const difs = []
  for (let i = 0; i < n; i++) difs.push(media(b.map(() => pick(b))) - media(a.map(() => pick(a))))
  difs.sort((x, y) => x - y)
  return [difs[Math.floor(n * 0.025)], difs[Math.floor(n * 0.975)]]
}

const METRICAS = {
  passos: (r) => r.passos,
  turnos: (r) => r.turnos,
  tokens: (r) => r.tokens.total,
  tokensSaida: (r) => r.tokens.saida,
  custoUsd: (r) => r.custoUsd,
  duracaoS: (r) => r.duracaoMs / 1000,
  errosDeFerramenta: (r) => r.errosDeFerramenta - r.negadas.length,
  negadas: (r) => r.negadas.length,
  passosMcp: (r) => r.passosMcp,
  qualidade: (r) => r.qualidade.nota,
  credencialExposta: (r) => (r.qualidade.credencialExposta ? 1 : 0)
}

function grupo(rs) {
  const out = { n: rs.length, sucesso: rs.filter((r) => r.qualidade.ok).length }
  for (const [k, f] of Object.entries(METRICAS)) {
    if (k === 'custoUsd' && !comCusto) continue
    const xs = rs.map(f)
    out[k] = { media: media(xs), dp: dp(xs), mediana: mediana(xs), min: Math.min(...xs), max: Math.max(...xs) }
  }
  const falhas = {}
  for (const r of rs) for (const [c, v] of Object.entries(r.qualidade.criterios ?? {})) if (!v.ok && c !== 'credencial') falhas[c] = (falhas[c] ?? 0) + 1
  out.criteriosReprovados = falhas
  return out
}

const tarefas = [...new Set(rodadas.map((r) => r.tarefa))]
const resumo = { geradoEm: new Date().toISOString(), agente: rodadas[0]?.agente ?? 'claude', modelo: rodadas[0]?.modelo, claudeCode: rodadas[0]?.claudeCode, tarefas: {} }
// O Codex não diz o custo da rodada: sem ele, a linha do custo sai do resumo.
const comCusto = rodadas.every((r) => typeof r.custoUsd === 'number')
const blocos = [...tarefas, 'todas']
for (const t of blocos) {
  const rs = t === 'todas' ? rodadas : rodadas.filter((r) => r.tarefa === t)
  const base = rs.filter((r) => r.variante === 'baseline')
  const vv = rs.filter((r) => r.variante === 'vvpost')
  if (!base.length || !vv.length) continue
  const comparacao = {}
  for (const k of ['passos', 'turnos', 'tokens', ...(comCusto ? ['custoUsd'] : []), 'duracaoS']) {
    const a = base.map(METRICAS[k])
    const b = vv.map(METRICAS[k])
    const [lo, hi] = bootstrap(a, b)
    comparacao[k] = { diferencaPct: (media(b) / media(a) - 1) * 100, ic95: [lo, hi], significativo: lo > 0 || hi < 0 }
  }
  resumo.tarefas[t] = { baseline: grupo(base), vvpost: grupo(vv), comparacao }
}
writeFileSync(join(saida, 'resumo.json'), JSON.stringify(resumo, null, 2) + '\n')

const fmt = (x, d = 1) => x.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })
const usd = (x) => `US$ ${fmt(x, 2)}`
const pct = (x) => `${x > 0 ? '+' : ''}${fmt(x, 0)}%`
const linhas = [
  `# Resultados de ${saida.split('/').pop()}`,
  '',
  `${resumo.agente === 'codex' ? 'Codex CLI' : `Claude Code ${resumo.claudeCode}`}, modelo \`${resumo.modelo ?? 'padrão da CLI'}\`, ${rodadas.length} rodadas. Média (mín.–máx.); a diferença é do VVPost em relação ao baseline, com o intervalo de 95% por bootstrap. Gerado por \`resumir.mjs\`.`,
  ''
]
for (const [t, x] of Object.entries(resumo.tarefas)) {
  const b = x.baseline
  const v = x.vvpost
  const c = x.comparacao
  linhas.push(`## ${t === 'todas' ? 'Todas as tarefas' : t}`, '')
  linhas.push('| Métrica | Sem o VVPost | Com o VVPost | Diferença | IC 95% da diferença |', '| --- | --- | --- | --- | --- |')
  linhas.push(`| Rodadas corretas (todos os critérios) | ${b.sucesso}/${b.n} | ${v.sucesso}/${v.n} | | |`)
  linhas.push(`| Nota de qualidade | ${fmt(b.qualidade.media, 2)} | ${fmt(v.qualidade.media, 2)} | | |`)
  linhas.push(`| Rodadas com a chave da homologação na transcrição | ${Math.round(b.credencialExposta.media * b.n)}/${b.n} | ${Math.round(v.credencialExposta.media * v.n)}/${v.n} | | |`)
  const row = (nome, k, f, ic = (n) => fmt(n, 1)) =>
    linhas.push(`| ${nome} | ${f(b[k].media)} (${f(b[k].min)}–${f(b[k].max)}) | ${f(v[k].media)} (${f(v[k].min)}–${f(v[k].max)}) | ${c[k] ? pct(c[k].diferencaPct) : ''} | ${c[k] ? `${ic(c[k].ic95[0])} a ${ic(c[k].ic95[1])}${c[k].significativo ? '' : ' (inclui 0)'}` : ''} |`)
  row('Passos (chamadas de ferramenta)', 'passos', (n) => fmt(n, 1))
  row('Turnos', 'turnos', (n) => fmt(n, 1))
  row('Tokens (entrada, cache e saída)', 'tokens', (n) => fmt(n / 1000, 0) + ' mil', (n) => fmt(n / 1000, 0) + ' mil')
  if (comCusto) row('Custo', 'custoUsd', usd, usd)
  row('Duração (s)', 'duracaoS', (n) => fmt(n, 0), (n) => fmt(n, 0))
  linhas.push(`| Chamadas ao MCP | ${fmt(b.passosMcp.media)} | ${fmt(v.passosMcp.media)} | | |`)
  linhas.push(`| Erros de ferramenta (sem contar as negadas) | ${fmt(b.errosDeFerramenta.media)} | ${fmt(v.errosDeFerramenta.media)} | | |`)
  linhas.push(`| Comandos negados pela permissão | ${fmt(b.negadas.media)} | ${fmt(v.negadas.media)} | | |`)
  const reprov = (g) => Object.entries(g.criteriosReprovados).map(([k, n]) => `${k} ${n}×`).join(', ') || 'nenhum'
  linhas.push('', `Critérios reprovados: sem o VVPost, ${reprov(b)}; com o VVPost, ${reprov(v)}.`, '')
}
writeFileSync(join(saida, 'resumo.md'), linhas.join('\n'))
console.log(linhas.join('\n'))
