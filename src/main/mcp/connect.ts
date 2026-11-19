import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * Liga um repositório de código ao VVPost num passo só, como o "Configure" dos MCPs de editor
 * (MCP for Unity, ctx7 setup): registra o servidor MCP em cada cliente de IA e grava a regra do
 * VVPost no arquivo de instruções que esse cliente lê (CLAUDE.md no Claude Code, AGENTS.md nos
 * outros). Tudo idempotente: rodar de novo não duplica nada.
 */

export type AgentClient = 'claude' | 'cursor' | 'vscode' | 'codex'

export const AGENT_CLIENTS: readonly { id: AgentClient; label: string; rules: 'CLAUDE.md' | 'AGENTS.md' }[] = [
  { id: 'claude', label: 'Claude Code', rules: 'CLAUDE.md' },
  { id: 'cursor', label: 'Cursor', rules: 'AGENTS.md' },
  { id: 'vscode', label: 'GitHub Copilot (VS Code)', rules: 'AGENTS.md' },
  { id: 'codex', label: 'Codex', rules: 'AGENTS.md' }
]

/** Como o cliente chega ao servidor: inicia o processo (stdio) ou fala com o app ligado (HTTP). */
export type McpEndpoint =
  | { transport: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { transport: 'http'; url: string; token?: boolean }

export interface ConnectStep {
  client: AgentClient | 'rule'
  /** Arquivo gravado, ou o comando do cliente que registra o servidor. */
  target: string
  action: 'created' | 'updated' | 'unchanged' | 'manual'
  /** Com manual: o que a pessoa roda (o CLI do cliente não está instalado). */
  command?: string
}

export interface ConnectOptions {
  /** Raiz do repositório de código (caminho absoluto). */
  repo: string
  workspace: string
  project?: string
  clients: readonly AgentClient[]
  endpoint: McpEndpoint
  dryRun?: boolean
  /** Para testes: roda o CLI de um cliente (claude, codex). code null: o programa não existe. */
  run?: (command: string, args: string[], cwd: string) => Promise<{ code: number | null; stdout: string }>
}

/** Nome do servidor nos clientes. */
const NAME = 'vvpost'
const TOKEN_ENV = 'VVPOST_MCP_TOKEN'

function runCommand(command: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    // No Windows o claude e o codex são .cmd: precisam do shell, que não põe aspas sozinho.
    const win = process.platform === 'win32'
    const argv = win ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args
    const child = spawn(command, argv, { cwd, shell: win, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.on('error', () => resolve({ code: null, stdout }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
  })
}

/** Os clientes que o repositório ou a máquina já usam; nenhum: Claude Code. */
export async function detectClients(repo: string, run = runCommand): Promise<AgentClient[]> {
  const found = new Set<AgentClient>()
  if (existsSync(join(repo, 'CLAUDE.md')) || existsSync(join(repo, '.claude'))) found.add('claude')
  if (existsSync(join(repo, '.cursor'))) found.add('cursor')
  if (existsSync(join(repo, '.vscode'))) found.add('vscode')
  const [claude, codex] = await Promise.all([run('claude', ['--version'], repo), run('codex', ['--version'], repo)])
  if (claude.code === 0) found.add('claude')
  if (codex.code === 0) found.add('codex')
  return found.size ? AGENT_CLIENTS.map((c) => c.id).filter((id) => found.has(id)) : ['claude']
}

const quote = (arg: string) => (/^[\w./:@=-]+$/.test(arg) ? arg : JSON.stringify(arg))

const envArgs = (env: Record<string, string> | undefined) => Object.entries(env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`])

/** O argumento de linha de comando que registra o servidor no Claude Code ou no Codex. */
function cliArgs(client: 'claude' | 'codex', endpoint: McpEndpoint): string[] {
  if (client === 'claude') {
    // --scope local: só nesta máquina e neste repositório (fica em ~/.claude.json, fora do git).
    return endpoint.transport === 'http'
      ? ['mcp', 'add', '--scope', 'local', '--transport', 'http', NAME, `${endpoint.url}/mcp`, ...(endpoint.token ? ['--header', `Authorization: Bearer \${${TOKEN_ENV}}`] : [])]
      : ['mcp', 'add', '--scope', 'local', ...envArgs(endpoint.env), NAME, '--', endpoint.command, ...endpoint.args]
  }
  return endpoint.transport === 'http'
    ? ['mcp', 'add', NAME, '--url', `${endpoint.url}/mcp`, ...(endpoint.token ? ['--bearer-token-env-var', TOKEN_ENV] : [])]
    : ['mcp', 'add', NAME, ...envArgs(endpoint.env), '--', endpoint.command, ...endpoint.args]
}

/** A entrada do servidor no .cursor/mcp.json ou no .vscode/mcp.json; o token vem do ambiente, nunca do arquivo. */
function fileEntry(client: 'cursor' | 'vscode', endpoint: McpEndpoint): Record<string, unknown> {
  const headers = endpoint.transport === 'http' && endpoint.token ? { headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` } } : {}
  if (endpoint.transport === 'http') return { ...(client === 'vscode' && { type: 'http' }), url: `${endpoint.url}/mcp`, ...headers }
  return { ...(client === 'vscode' && { type: 'stdio' }), command: endpoint.command, args: endpoint.args, ...(endpoint.env && { env: endpoint.env }) }
}

async function writeJsonEntry(file: string, key: 'mcpServers' | 'servers', entry: Record<string, unknown>, dryRun: boolean): Promise<ConnectStep['action']> {
  const exists = existsSync(file)
  let config: Record<string, unknown> = {}
  if (exists) {
    try {
      config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    } catch {
      throw new Error(`${file} não é um JSON válido; corrija o arquivo e rode de novo`)
    }
  }
  const servers = (config[key] && typeof config[key] === 'object' ? config[key] : {}) as Record<string, unknown>
  if (JSON.stringify(servers[NAME]) === JSON.stringify(entry)) return 'unchanged'
  if (!dryRun) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify({ ...config, [key]: { ...servers, [NAME]: entry } }, null, 2)}\n`)
  }
  return exists ? 'updated' : 'created'
}

async function registerWithCli(client: 'claude' | 'codex', options: ConnectOptions, run: NonNullable<ConnectOptions['run']>): Promise<ConnectStep> {
  const args = cliArgs(client, options.endpoint)
  const command = `${client} ${args.map(quote).join(' ')}`
  const current = await run(client, ['mcp', 'get', NAME], options.repo)
  if (current.code === null) return { client, target: command, action: 'manual', command }
  const wanted = options.endpoint.transport === 'http' ? `${options.endpoint.url}/mcp` : options.endpoint.args.join(' ')
  if (current.code === 0 && current.stdout.includes(wanted)) return { client, target: command, action: 'unchanged' }
  if (!options.dryRun) {
    if (current.code === 0) await run(client, client === 'claude' ? ['mcp', 'remove', '--scope', 'local', NAME] : ['mcp', 'remove', NAME], options.repo)
    const added = await run(client, args, options.repo)
    if (added.code !== 0) return { client, target: command, action: 'manual', command }
  }
  return { client, target: command, action: current.code === 0 ? 'updated' : 'created' }
}

export async function connectRepo(options: ConnectOptions): Promise<ConnectStep[]> {
  const run = options.run ?? runCommand
  const dryRun = options.dryRun === true
  const docs = await import('@vvpost/core/docs')
  const steps: ConnectStep[] = []
  for (const client of options.clients) {
    if (client === 'claude' || client === 'codex') steps.push(await registerWithCli(client, options, run))
    else {
      const file = join(options.repo, client === 'cursor' ? '.cursor/mcp.json' : '.vscode/mcp.json')
      steps.push({ client, target: file, action: await writeJsonEntry(file, client === 'cursor' ? 'mcpServers' : 'servers', fileEntry(client, options.endpoint), dryRun) })
    }
  }
  // A regra vai no arquivo que cada cliente lê: o Claude Code lê CLAUDE.md; Cursor, Copilot e Codex, AGENTS.md.
  const ruleFiles = [...new Set(options.clients.map((c) => AGENT_CLIENTS.find((x) => x.id === c)!.rules))]
  for (const name of ruleFiles) {
    const { file, action } = await docs.installAgentSnippet(
      join(options.repo, name),
      { workspace: options.workspace, ...(options.project && { project: options.project }) },
      { dryRun }
    )
    steps.push({ client: 'rule', target: file, action: action === 'appended' ? 'updated' : action })
  }
  return steps
}
