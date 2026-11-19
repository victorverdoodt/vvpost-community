// O Codex CLI como agente do benchmark (--agente codex): o mesmo pedido, o mesmo repositório e o mesmo MCP do VVPost,
// em `codex exec --json`. O que muda em relação ao Claude Code, e que o benchmark quer medir: o servidor do MCP entra
// no contexto só pela primeira linha das instruções, as ferramentas dele vêm pelo tool_search (BM25 em inglês), e o
// resultado de ferramenta passa de 10 mil tokens é cortado no meio.

/** Variáveis que o Codex precisa de quem roda o benchmark: o login (CODEX_HOME) ou a chave. */
export const ENV_CODEX = /^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_HOME|OPENAI_BASE_URL)$/

/**
 * Os argumentos do `codex exec`. Edita só a cópia do repositório (workspace-write, sem pedir aprovação) e alcança a
 * homologação local nas duas variantes (a rede dos comandos fica ligada: o baseline usa curl). O config do usuário
 * fica de fora (--ignore-user-config) e o CLAUDE.md das variantes vale como o AGENTS.md, para as duas receberem as
 * mesmas instruções que o Claude Code recebe.
 */
export function argumentosCodex({ prompt, modelo, mcp }) {
  const argv = [
    'exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral',
    '--sandbox', 'workspace-write',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', 'project_doc_fallback_filenames=["CLAUDE.md"]',
    '-c', 'web_search="disabled"'
  ]
  if (modelo) argv.push('-m', modelo)
  const vvpost = mcp?.mcpServers?.vvpost
  if (vvpost) {
    // Arrays JSON de strings também são arrays TOML válidos.
    argv.push('-c', `mcp_servers.vvpost.command=${JSON.stringify(vvpost.command)}`, '-c', `mcp_servers.vvpost.args=${JSON.stringify(vvpost.args)}`)
  }
  argv.push(prompt)
  return argv
}

const eventos = (linhas) => linhas.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

/**
 * Métricas de uma transcrição do `codex exec --json`, na mesma forma do medir() do Claude Code.
 * @param {string[]} linhas
 * @param {{ duracaoMs?: number | null, modelo?: string | null }} [opcoes]
 */
export function medirCodex(linhas, { duracaoMs = null, modelo = null } = {}) {
  const ev = eventos(linhas)
  const itens = ev.filter((e) => e.type === 'item.completed').map((e) => e.item ?? {})
  const usos = []
  const erros = []
  for (const it of itens) {
    const nome =
      it.type === 'command_execution' ? 'Bash'
      : it.type === 'file_change' ? 'Edit'
      : it.type === 'mcp_tool_call' ? `mcp__${it.server}__${it.tool}`
      : it.type === 'web_search' ? 'WebSearch'
      : null
    if (!nome) continue
    usos.push(nome)
    if (it.status === 'failed' || it.status === 'declined' || it.error) erros.push(nome)
  }
  const porFerramenta = {}
  for (const n of usos) porFerramenta[n] = (porFerramenta[n] ?? 0) + 1
  // O uso vem por turno (um turno do exec é o pedido inteiro); soma, para o caso de haver mais de um.
  const u = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }
  for (const e of ev.filter((e) => e.type === 'turn.completed')) for (const k of Object.keys(u)) u[k] += e.usage?.[k] ?? 0
  const entrada = u.input_tokens - u.cached_input_tokens
  return {
    agente: 'codex',
    claudeCode: null,
    modelo,
    ferramentasDisponiveis: [],
    mcp: [],
    turnos: ev.filter((e) => e.type === 'turn.completed').length,
    passos: usos.length,
    passosMcp: usos.filter((n) => n.startsWith('mcp__')).length,
    errosDeFerramenta: erros.length,
    ferramentasComErro: erros,
    negadas: [],
    porFerramenta,
    tokens: {
      entrada,
      escritaCache: u.cache_write_input_tokens,
      leituraCache: u.cached_input_tokens,
      saida: u.output_tokens,
      total: entrada + u.cache_write_input_tokens + u.cached_input_tokens + u.output_tokens
    },
    // O --json do Codex não diz o custo.
    custoUsd: null,
    custoPorModelo: {},
    duracaoMs,
    terminou: ev.some((e) => e.type === 'turn.completed') && !ev.some((e) => e.type === 'turn.failed' || e.type === 'error')
  }
}

/** O texto final do agente: a última mensagem dele. */
export function respostaFinalCodex(linhas) {
  const msgs = eventos(linhas).filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
  return msgs.at(-1)?.item.text ?? ''
}
