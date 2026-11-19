// Benchmark de agentes com e sem o VVPost: roda cada tarefa nas duas variantes do mesmo
// repositório com o Claude Code (ou o Codex, com --agente codex) em modo headless, grava a transcrição e corrige o
// resultado.
// Metodologia em docs/benchmark-agentes.md.
//
//   npm run build
//   node bench/agentes/rodar.mjs --rodadas 5 [--tarefas alterar-endpoint,...] [--variantes baseline,vvpost]
//                                [--modelo claude-sonnet-5-5] [--paralelo 3] [--saida <pasta>] [--agente claude|codex]
//   node bench/agentes/rodar.mjs --preparar <variante> <pasta>   (só monta o repositório)
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corrigir } from './corrigir.mjs'
import { iniciarHomolog } from './homolog.mjs'
import { argumentosCodex, ENV_CODEX, medirCodex, respostaFinalCodex } from './codex.mjs'

const AQUI = dirname(fileURLToPath(import.meta.url))
const RAIZ = resolve(AQUI, '../..')
const TAREFAS = ['alterar-endpoint', 'remover-dependencia', 'novo-endpoint', 'consultar-api', 'atualizar-integracao']
const VARIANTES = ['baseline', 'vvpost']

// O agente edita só a cópia do repositório (acceptEdits) e roda só estes comandos, nas duas
// variantes. Web e subagentes ficam fora: os passos de um subagente não aparecem na contagem.
const PERMITIDAS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite',
  'Bash(npm test:*)', 'Bash(node --test:*)', 'Bash(node -e:*)', 'Bash(git status:*)', 'Bash(git diff:*)',
  'Bash(git rm:*)', 'Bash(git mv:*)', 'Bash(ls:*)', 'Bash(grep:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)',
  'Bash(find:*)', 'Bash(wc:*)', 'Bash(sed:*)', 'Bash(curl:*)', 'Bash(vvpost:*)'
]
const BLOQUEADAS = ['WebSearch', 'WebFetch', 'Agent', 'Task']

// O agente medido recebe só estas variáveis de quem roda o benchmark (rede, certificados e login do
// Claude Code): nada da sessão que chamou o benchmark, para que ele seja um Claude Code comum.
const ENV_PASSA = /^(PATH|HOME|LANG|LC_ALL|TERM|TMPDIR|USER|SHELL|https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|GLOBAL_AGENT_.*|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|ANTHROPIC_.*|CLAUDE_SESSION_INGRESS_TOKEN_FILE|CLAUDE_CODE_OAUTH_TOKEN)$/

function args() {
  const a = process.argv.slice(2)
  const op = { rodadas: 1, tarefas: TAREFAS, variantes: VARIANTES, modelo: null, paralelo: 3, saida: null, preparar: null, agente: 'claude' }
  for (let i = 0; i < a.length; i++) {
    const v = a[i + 1]
    if (a[i] === '--rodadas') (op.rodadas = Number(v)), i++
    else if (a[i] === '--tarefas') (op.tarefas = v.split(',')), i++
    else if (a[i] === '--variantes') (op.variantes = v.split(',')), i++
    else if (a[i] === '--modelo') (op.modelo = v), i++
    else if (a[i] === '--paralelo') (op.paralelo = Number(v)), i++
    else if (a[i] === '--saida') (op.saida = resolve(v)), i++
    else if (a[i] === '--agente') (op.agente = v), i++
    else if (a[i] === '--preparar') (op.preparar = a.slice(i + 1, i + 3)), (i += 2)
  }
  return op
}

const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', ...a], { cwd, encoding: 'utf8' })

// A porta da homologação entra nos arquivos que a citam (CLAUDE.md, ambiente do VVPost).
const PORTA = '__PORTA_HOMOLOG__'
function trocarPorta(dir, porta) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) trocarPorta(p, porta)
    else {
      const t = readFileSync(p, 'utf8')
      if (t.includes(PORTA)) writeFileSync(p, t.split(PORTA).join(String(porta)))
    }
  }
}

export function preparar(variante, destino, { porta = 0, chave } = {}) {
  mkdirSync(destino, { recursive: true })
  cpSync(join(AQUI, 'projeto'), destino, { recursive: true })
  cpSync(join(AQUI, variante), destino, { recursive: true })
  trocarPorta(destino, porta)
  // Sem o VVPost, a chave fica onde um time costuma deixá-la: num .env fora do Git.
  if (variante === 'baseline' && chave) writeFileSync(join(destino, '.env.homolog'), `LOJA_API_KEY=${chave}\n`)
  // Com o VVPost, a chave da homologação está no cofre (o formato antigo migra na primeira leitura).
  if (variante === 'vvpost' && chave) {
    mkdirSync(join(destino, 'api/.vvpost'), { recursive: true })
    writeFileSync(join(destino, 'api/.vvpost/secrets.local.json'), JSON.stringify({ homolog: { LOJA_API_KEY: chave } }))
  }
  git(destino, 'init', '-q', '-b', 'main')
  git(destino, 'add', '-A')
  git(destino, 'commit', '-qm', 'estado inicial')
  return destino
}

function prompt(tarefa) {
  return [
    'Você está no repositório da Loja API. Faça a tarefa abaixo do começo ao fim, sem perguntar nada.',
    '',
    readFileSync(join(AQUI, 'tarefas', `${tarefa}.md`), 'utf8').trim()
  ].join('\n')
}

function mcpConfig(variante, repo, stats) {
  if (variante !== 'vvpost') return { mcpServers: {} }
  return {
    mcpServers: {
      vvpost: {
        command: process.execPath,
        args: [join(RAIZ, 'out/main/mcp.js'), '--workspace', join(repo, 'api'), '--repo', repo, '--stats', stats]
      }
    }
  }
}

// Métricas de uma transcrição stream-json do Claude Code.
export function medir(linhas) {
  const ev = linhas.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const init = ev.find((e) => e.type === 'system' && e.subtype === 'init')
  const fim = ev.findLast((e) => e.type === 'result')
  const usos = []
  const erros = []
  const ids = new Map()
  for (const e of ev) {
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (e.type === 'assistant' && b.type === 'tool_use') {
        usos.push(b.name)
        ids.set(b.id, b.name)
      }
      if (e.type === 'user' && b.type === 'tool_result' && b.is_error) erros.push(ids.get(b.tool_use_id) ?? '?')
    }
  }
  const porFerramenta = {}
  for (const n of usos) porFerramenta[n] = (porFerramenta[n] ?? 0) + 1
  const u = fim?.usage ?? {}
  return {
    claudeCode: init?.claude_code_version ?? null,
    modelo: init?.model ?? null,
    ferramentasDisponiveis: init?.tools ?? [],
    mcp: init?.mcp_servers ?? [],
    turnos: fim?.num_turns ?? null,
    passos: usos.length,
    passosMcp: usos.filter((n) => n.startsWith('mcp__')).length,
    errosDeFerramenta: erros.length,
    ferramentasComErro: erros,
    negadas: (fim?.permission_denials ?? []).map((d) => d.tool_name),
    porFerramenta,
    tokens: {
      entrada: u.input_tokens ?? 0,
      escritaCache: u.cache_creation_input_tokens ?? 0,
      leituraCache: u.cache_read_input_tokens ?? 0,
      saida: u.output_tokens ?? 0,
      total: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
    },
    custoUsd: fim?.total_cost_usd ?? null,
    custoPorModelo: Object.fromEntries(Object.entries(fim?.modelUsage ?? {}).map(([m, x]) => [m, x.costUSD])),
    duracaoMs: fim?.duration_ms ?? null,
    terminou: fim?.subtype === 'success' && !fim?.is_error
  }
}

/** O texto final do agente (o `result` do Claude Code). */
export function respostaFinal(linhas) {
  for (let i = linhas.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(linhas[i])
      if (e.type === 'result') return e.result ?? ''
    } catch {
      // linha cortada
    }
  }
  return ''
}

// O comando `vvpost` que quem tem o VVPost instalado usa no terminal; só na variante vvpost.
function binVvpost(dir) {
  mkdirSync(dir, { recursive: true })
  const f = join(dir, 'vvpost')
  writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${join(RAIZ, 'out/main/cli.js')}" "$@"\n`)
  chmodSync(f, 0o755)
  return dir
}

async function rodada({ tarefa, variante, n, modelo, saida, agente }) {
  const nome = `${agente === 'codex' ? 'codex.' : ''}${tarefa}.${variante}.${n}`
  const pasta = join(saida, 'rodadas', nome)
  mkdirSync(pasta, { recursive: true })
  const base = mkdtempSync(join(tmpdir(), 'vvpost-bench-'))
  // Toda rodada tem a homologação no ar, com uma chave nova, para que as variantes vejam o mesmo projeto.
  const chave = `hk-${randomBytes(12).toString('hex')}`
  const homolog = await iniciarHomolog(chave)
  const repo = preparar(variante, join(base, 'loja-api'), { porta: homolog.porta, chave })
  const stats = join(pasta, 'mcp-stats.jsonl')
  const cfg = join(pasta, 'mcp.json')
  writeFileSync(cfg, JSON.stringify(mcpConfig(variante, repo, stats), null, 2))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV_PASSA.test(k) || (agente === 'codex' && ENV_CODEX.test(k))))
  // Sem memória entre rodadas.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
  // O cofre do VVPost de cada rodada fica com a rodada, longe do cofre de quem roda o benchmark.
  env.VVPOST_VAULT_DIR = join(base, 'cofre')
  if (variante === 'vvpost') env.PATH = binVvpost(join(base, 'bin')) + delimiter + env.PATH

  const argv = agente === 'codex' ? argumentosCodex({ prompt: prompt(tarefa), modelo, mcp: mcpConfig(variante, repo, stats) }) : [
    '-p', prompt(tarefa),
    '--output-format', 'stream-json', '--verbose',
    '--model', modelo ?? 'claude-sonnet-5-5',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', [...PERMITIDAS, ...(variante === 'vvpost' ? ['mcp__vvpost'] : [])].join(','),
    '--disallowedTools', BLOQUEADAS.join(','),
    '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', cfg,
    '--max-turns', '80'
  ]
  const inicio = Date.now()
  return new Promise((ok) => {
    const p = spawn(agente === 'codex' ? 'codex' : 'claude', argv, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const limite = setTimeout(() => p.kill('SIGTERM'), 30 * 60_000)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('close', async (code) => {
      await homolog.fechar()
      clearTimeout(limite)
      writeFileSync(join(pasta, 'transcricao.jsonl'), out)
      if (err.trim()) writeFileSync(join(pasta, 'stderr.txt'), err)
      git(repo, 'add', '-A')
      writeFileSync(join(pasta, 'diff.patch'), git(repo, 'diff', '--cached', '--no-color').stdout)
      const linhas = out.split('\n').filter(Boolean)
      const metricas = agente === 'codex' ? medirCodex(linhas, { duracaoMs: Date.now() - inicio, modelo }) : { agente: 'claude', ...medir(linhas) }
      const resposta = agente === 'codex' ? respostaFinalCodex(linhas) : respostaFinal(linhas)
      let correcao
      try {
        correcao = corrigir(tarefa, variante, repo, { esperado: homolog.esperado, resposta, chave, transcricao: out })
      } catch (e) {
        correcao = { ok: false, nota: 0, erro: e.message }
      }
      // A chave é de mentira, só desta rodada: fica nos dados para a correção poder ser refeita.
      const linha = { rodada: nome, tarefa, variante, n, inicio: new Date(inicio).toISOString(), saidaCli: code, ...metricas, homolog: { porta: homolog.porta, chave, esperado: homolog.esperado }, resposta, qualidade: correcao }
      writeFileSync(join(pasta, 'resultado.json'), JSON.stringify(linha, null, 2))
      appendFileSync(join(saida, 'rodadas.jsonl'), JSON.stringify(linha) + '\n')
      rmSync(base, { recursive: true, force: true })
      console.log(`${nome}: ${metricas.passos} passos, ${metricas.custoUsd == null ? `${metricas.tokens.total} tokens` : `US$ ${metricas.custoUsd.toFixed(2)}`}, qualidade ${correcao.nota?.toFixed(2)}${correcao.ok ? ' ✓' : ''}`)
      ok(linha)
    })
  })
}

async function main() {
  const op = args()
  if (op.preparar) {
    const [variante, pasta] = op.preparar
    console.log(preparar(variante, resolve(pasta)))
    return
  }
  if (!existsSync(join(RAIZ, 'out/main/mcp.js'))) throw new Error('rode npm run build antes')
  const saida = op.saida ?? join(AQUI, 'resultados', new Date().toISOString().slice(0, 10))
  mkdirSync(saida, { recursive: true })
  // Ordem intercalada (rodada, tarefa, variante), para que a hora não favoreça uma variante.
  const fila = []
  for (let n = 1; n <= op.rodadas; n++) for (const tarefa of op.tarefas) for (const variante of op.variantes) fila.push({ tarefa, variante, n, modelo: op.modelo, saida, agente: op.agente })
  const ativos = new Set()
  for (const item of fila) {
    while (ativos.size >= op.paralelo) await Promise.race(ativos)
    const p = rodada(item).finally(() => ativos.delete(p))
    ativos.add(p)
  }
  await Promise.all(ativos)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
