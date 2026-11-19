import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { HttpMethod } from '@shared/ipc'
import { createAuthEngine } from '@vvpost/core/connectors/auth'
import { createHttpDispatcher } from '@vvpost/core/http/dispatcher'
import { featureDenial } from '@vvpost/core/policy/features'
import { MCP_POLICY_DEFAULTS } from '@vvpost/core/policy/request-policy'
import { DETECTABLE, type DetectablePii } from '@vvpost/core/pii'
import { enclosingProjectDir, projectDir } from '@vvpost/core/projects'
import { setSharedConnectors, type SharedConnector } from '@vvpost/core/connectors/shared'
import { readCatalogFile } from '../cli/catalog'
import { sharedConnectors, type AgentSession } from '../enterprise/control-plane'
import { safeOpen } from '../enterprise/identity'
import { applyFeaturePolicy, openFeaturePolicy } from '../enterprise/features'
import { readOrganization } from '../enterprise/organization'
import { loadEnterpriseModule } from '../secret-engine/backend'
import { clearReviewMarks, markUnreviewedFlows } from '../project/review'
import { centralAgentPolicy, effectiveAgentPolicy, openAgentSession, unavailableSession } from './central'
import { createMcpServer } from './server'
import type { McpWebhooks } from './tools'
import { DEFAULT_MCP_PORT, serveHttp, serveStdio } from './transports'
import { MCP_TOOL_PROFILES, MCP_TOOL_SUMMARIES, resolveToolSelection } from '@shared/mcp-tools'
import { readStats, usageReport } from './usage'

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

const HELP = `VVPost MCP: catálogo de APIs, execução de testes e edição do projeto para agentes de IA.

Uso: node out/main/mcp.js [opções]

  --workspace <pasta>   Workspace VVPost (padrão: $VVPOST_WORKSPACE ou a pasta atual)
  --project <id>        Projeto em que as ferramentas trabalham sem o argumento project (padrão:
                        $VVPOST_PROJECT, ou o projeto que contém a pasta; senão, o Compartilhado)
  --repo <pasta>        Repositório de código em que o agente trabalha (padrão no stdio: o da pasta atual, se
                        estiver fora do workspace). Sem a regra do VVPost no CLAUDE.md ou AGENTS.md dele, o
                        servidor pede ao agente para oferecer install_agent_rules
  --transport <tipo>    stdio (padrão) ou http (Streamable HTTP em /mcp e SSE em /sse)
  --sse                 O mesmo que --transport http
  --port <n>            Porta do transporte http (padrão: ${DEFAULT_MCP_PORT})
  --token <valor>       Exige "Authorization: Bearer <valor>" no http (ou $VVPOST_MCP_TOKEN)
  --read-only           Nada é enviado para as APIs nem gravado no projeto: execute_dry_run só monta as requisições
  --no-write            A IA não edita o projeto (edit_project e import_postman com apply recusam)
  --approve-review      Confirma as alterações de auth, destino e código que a IA fez e sai. Com a política
                        do Control Plane mandando aprovar no console, recusa (POLICY_DENIED) e abre o pedido lá
  --allow-env <ids>     Ambientes em que a IA pode disparar, separados por vírgula
  --allow-methods <m>   Métodos HTTP que a IA pode disparar (ex.: GET,HEAD); padrão: todos
  --rate <n>            Requisições por minuto que a IA pode disparar (padrão: ${MCP_POLICY_DEFAULTS.rate.requests})
  --pii-detect          Mascara também dados pessoais em campos sem x-sensitive, reconhecidos pelo formato
                        (${DETECTABLE.join(', ')}). Soma com o .vvpost/privacy.json do workspace
  --pii-types <tipos>   O mesmo, só com estes tipos, separados por vírgula (ex.: cpf,email)
  --webhooks            Liga o servidor local de webhooks junto: a IA lê os eventos (list_webhook_events)
                        e os fluxos com nó webhook esperam por eles. Os hooks não disparam fluxos aqui
  --webhook-port <n>    Porta do servidor de webhooks (padrão: a de .vvpost/webhooks.json ou 4480)
  --catalog <arquivo>   Conectores compartilhados, somente leitura (repetível): a resposta de
                        GET /api/v1/catalog do Control Plane, uma lista de conectores ou um conector só.
                        Com o VVPost Enterprise, o catálogo central entra sozinho depois do login
  --stats <arquivo>     Acrescenta uma linha JSON por chamada de ferramenta (ferramenta, ms, caracteres
                        dos argumentos e da resposta), para medir chamadas e tokens por tarefa
  --tools <lista>       Anuncia só estas ferramentas: perfis (${Object.keys(MCP_TOOL_PROFILES).join(', ')}, tudo) e
                        nomes, separados por vírgula (ex.: contrato,get_brand). Padrão: tudo. Cada ferramenta
                        anunciada vai em todo turno do agente
  --enxuto             O tools/list traz só a primeira frase e os tipos dos argumentos de cada ferramenta, e
                        describe_tool devolve o resto quando a IA vai usar uma (menos tokens em todo turno)
  --usage <arquivo>     Lê arquivos do --stats (repetível), mostra o uso de cada ferramenta e as que ficaram
                        sem uso, sugere um --tools e sai. Com --json, em JSON
  --help                Mostra esta ajuda

Com o VVPost Enterprise e um Control Plane (declarado no .vvpost/organization.json do workspace ou
registrado com vvpost login <url>), a política do agente da organização vale
por cima destas flags: ela só restringe, e sem ela (sem login, servidor fora) o servidor só lê o
catálogo e os documentos. O login corporativo abre no navegador ao iniciar, e o catálogo central
da organização (as bases herdadas com extends) é sincronizado depois dele.
`

/**
 * Servidor MCP do VVPost fora do app, para o cliente de IA iniciar por
 * stdio ou para expor em HTTP/SSE. Roda em Node puro (ou no Electron com
 * ELECTRON_RUN_AS_NODE=1): não carrega nada do Electron nem a interface.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      project: { type: 'string' },
      repo: { type: 'string' },
      transport: { type: 'string' },
      sse: { type: 'boolean' },
      port: { type: 'string' },
      token: { type: 'string' },
      'read-only': { type: 'boolean' },
      'no-write': { type: 'boolean' },
      'approve-review': { type: 'boolean' },
      'allow-env': { type: 'string' },
      'allow-methods': { type: 'string' },
      rate: { type: 'string' },
      'pii-detect': { type: 'boolean' },
      'pii-types': { type: 'string' },
      webhooks: { type: 'boolean' },
      'webhook-port': { type: 'string' },
      stats: { type: 'string' },
      catalog: { type: 'string', multiple: true },
      tools: { type: 'string' },
      enxuto: { type: 'boolean' },
      usage: { type: 'string', multiple: true },
      json: { type: 'boolean' },
      help: { type: 'boolean' }
    }
  })
  if (values.help) {
    process.stderr.write(HELP)
    return
  }
  const log = (line: string) => process.stderr.write(`[vvpost-mcp] ${line}\n`)
  if (values.usage) {
    try {
      const report = usageReport(await readStats(values.usage.map((p) => resolve(p))))
      process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : report.text)
    } catch (err) {
      log((err as Error).message)
      process.exitCode = 2
    }
    return
  }
  let toolNames: Set<string> | null = null
  if (values.tools !== undefined) {
    const selection = resolveToolSelection(values.tools, MCP_TOOL_SUMMARIES.map(([name]) => name))
    if (selection.unknown.length) {
      log(`--tools: desconhecido: ${selection.unknown.join(', ')} (perfis: ${Object.keys(MCP_TOOL_PROFILES).join(', ')}, tudo; ou nomes de ferramentas)`)
      process.exitCode = 2
      return
    }
    toolNames = selection.tools
  }
  const folder = resolve(values.workspace ?? process.env['VVPOST_WORKSPACE'] ?? process.cwd())
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    log(`workspace não encontrado: ${folder}`)
    process.exitCode = 2
    return
  }
  const projectId = values.project ?? process.env['VVPOST_PROJECT']
  let workspaceDir: string
  try {
    workspaceDir = projectId ? projectDir(enclosingProjectDir(folder) ?? folder, projectId) : (enclosingProjectDir(folder) ?? folder)
  } catch (err) {
    log((err as Error).message)
    process.exitCode = 2
    return
  }
  // Conectores compartilhados: os do --catalog e o catálogo central do módulo Enterprise, que o
  // módulo sincroniza depois do login (até lá, a última cópia em disco).
  const fromFiles: SharedConnector[] = []
  try {
    for (const path of values.catalog ?? []) fromFiles.push(...(await readCatalogFile(resolve(path))))
  } catch (err) {
    log((err as Error).message)
    process.exitCode = 2
    return
  }
  setSharedConnectors(async () => [...fromFiles, ...(await sharedConnectors().catch(() => []))])
  // A organização que o workspace declara (.vvpost/organization.json): o projeto vence a raiz.
  let declared
  try {
    declared = await readOrganization([...new Set([workspaceDir, enclosingProjectDir(workspaceDir) === workspaceDir ? dirname(workspaceDir) : workspaceDir])])
  } catch (err) {
    log((err as Error).message)
    process.exitCode = 2
    return
  }
  // Política do agente do Control Plane, quando a organização usa um (módulo Enterprise).
  let session: AgentSession | null
  try {
    session = await openAgentSession({ surface: 'stdio', openExternal: safeOpen(openInBrowser(log)) }, loadEnterpriseModule, declared)
  } catch (err) {
    session = unavailableSession(`módulo Enterprise: ${(err as Error).message}`)
  }
  const central = session ? centralAgentPolicy(session, log) : null
  // Recursos desligados pela organização (o próprio MCP, webhooks, nó Python...): segue o login acima.
  const features = await openFeaturePolicy({ surface: 'stdio' }, loadEnterpriseModule, declared)
  applyFeaturePolicy(features)
  await features?.ready()
  if (values['approve-review']) {
    // Comando do usuário, não da IA: confirma as alterações de auth, destino e código que a IA fez.
    // Inclui os fluxos com código ainda não revisado (migração das marcas de fluxo).
    await markUnreviewedFlows(workspaceDir)
    if (session && central) {
      const state = await session.ready()
      if (effectiveAgentPolicy({}, state).centralReview) {
        // A aprovação é de quem a política manda, no console: aqui só se abre o pedido.
        if (state.status === 'active') await central.syncReviews(workspaceDir)
        process.stderr.write(
          `POLICY_DENIED: ${
            state.status === 'active'
              ? 'a política do agente da organização manda aprovar no console do Control Plane. O pedido de revisão foi aberto lá.'
              : `sem a política do Control Plane (${state.status === 'unavailable' ? state.reason : 'sem resposta'}), a revisão não pode ser aprovada aqui.`
          }\n`
        )
        await Promise.all([session.close(), features?.close()])
        process.exitCode = 3
        return
      }
    }
    const approved = await clearReviewMarks(workspaceDir)
    process.stdout.write(
      approved.length ? `Revisados: ${approved.join(', ')}\n` : 'Nenhum conector aguardando revisão.\n'
    )
    await Promise.all([session?.close(), features?.close()])
    return
  }
  const transport = values.sse ? 'http' : (values.transport ?? 'stdio')
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    log(`transporte desconhecido: ${transport} (use stdio ou http)`)
    process.exitCode = 2
    return
  }
  const allowEnv = values['allow-env']
  let allowMethods: Set<HttpMethod> | undefined
  if (values['allow-methods'] !== undefined) {
    const list = values['allow-methods'].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    const unknown = list.filter((m) => !HTTP_METHODS.includes(m as HttpMethod))
    if (unknown.length) {
      log(`método desconhecido: ${unknown.join(', ')} (use ${HTTP_METHODS.join(', ')})`)
      process.exitCode = 2
      return
    }
    allowMethods = new Set(list as HttpMethod[])
  }
  const rate = values.rate === undefined ? undefined : Number(values.rate)
  if (rate !== undefined && (!Number.isInteger(rate) || rate < 1)) {
    log(`--rate inválido: ${values.rate} (requisições por minuto, inteiro maior que 0)`)
    process.exitCode = 2
    return
  }
  // --pii-detect liga todos os tipos; --pii-types só os da lista.
  let piiDetect: boolean | DetectablePii[] = values['pii-detect'] === true
  const piiTypes = values['pii-types']
  if (piiTypes !== undefined) {
    const list = piiTypes.split(',').map((s) => s.trim()).filter(Boolean)
    const unknown = list.filter((t) => !(DETECTABLE as readonly string[]).includes(t))
    if (unknown.length) {
      log(`tipo de dado pessoal desconhecido: ${unknown.join(', ')} (use ${DETECTABLE.join(', ')})`)
      process.exitCode = 2
      return
    }
    piiDetect = list as DetectablePii[]
  }
  const webhookPort = values['webhook-port'] === undefined ? undefined : Number(values['webhook-port'])
  if (webhookPort !== undefined && (!Number.isInteger(webhookPort) || webhookPort < 0 || webhookPort > 65535)) {
    log(`--webhook-port inválida: ${values['webhook-port']}`)
    process.exitCode = 2
    return
  }
  let webhooks: McpWebhooks | null = null
  let closeWebhooks = async () => {}
  const webhooksOff = values.webhooks || webhookPort !== undefined ? featureDenial('webhooks') : null
  if (webhooksOff) log(`webhooks não ligados: ${webhooksOff}`)
  else if (values.webhooks || webhookPort !== undefined) {
    const [{ startWebhookServer }, { loadWorkspace }] = await Promise.all([
      import('../webhooks/server'),
      import('@vvpost/core/connectors/workspace')
    ])
    const running = await startWebhookServer(workspaceDir, {
      ...(webhookPort !== undefined && { port: webhookPort }),
      workspace: () => loadWorkspace(workspaceDir)
    })
    webhooks = { url: running.url, inbox: running.inbox }
    closeWebhooks = () => running.close()
    log(`webhooks em ${running.url}`)
  }
  // O cliente inicia o stdio na pasta em que trabalha: fora do workspace, é o repositório de código.
  let codeRepo: string | undefined
  const cwd = process.cwd()
  const fromWorkspace = relative(folder, cwd)
  const fromCwd = transport === 'stdio' && (fromWorkspace.startsWith('..') || isAbsolute(fromWorkspace))
  if (values.repo !== undefined || fromCwd) {
    const { codeRepoRoot } = await import('@vvpost/core/docs')
    codeRepo = await codeRepoRoot(values.repo !== undefined ? resolve(values.repo) : cwd)
  }
  const statsFile = values.stats === undefined ? undefined : resolve(values.stats)
  // Proxy pelas variáveis de ambiente, como o curl; sem cookie jar.
  const http = createHttpDispatcher({}, { proxy: { mode: 'env' } })
  const server = createMcpServer({
    workspaceDir,
    http,
    auth: createAuthEngine(),
    ...(values['read-only'] && { readOnly: true }),
    ...(values['no-write'] && { noWrite: true }),
    ...(allowMethods && { allowMethods }),
    ...(piiDetect !== false && { piiDetect }),
    ...(rate !== undefined && { limits: { ...MCP_POLICY_DEFAULTS, rate: { requests: rate, perMs: 60_000 } } }),
    ...(allowEnv !== undefined && {
      allowEnvironments: new Set(allowEnv.split(',').map((s) => s.trim()).filter(Boolean))
    }),
    ...(webhooks && { webhooks: () => webhooks }),
    ...(codeRepo && { codeRepo }),
    ...(statsFile && { stats: (entry) => appendFileSync(statsFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`) }),
    ...(central && { central }),
    ...(toolNames && { toolNames }),
    ...(values.enxuto && { enxuto: true }),
    surface: 'stdio',
    log
  })
  const mcpOff = featureDenial('mcp')
  if (mcpOff) log(`${mcpOff}: as ferramentas respondem POLICY_DENIED`)
  if (session) {
    void session.ready().then((state) =>
      log(state.status === 'active' ? `política do agente do Control Plane em vigor (${state.source})` : state.status === 'unavailable' ? `política do agente indisponível: ${state.reason}; modo mais restrito` : 'sem Control Plane')
    )
  }

  if (transport === 'stdio') {
    log(`workspace ${workspaceDir} (stdio${values['read-only'] ? ', somente leitura' : ''}${toolNames ? `, ${toolNames.size} ferramentas` : ''})`)
    await serveStdio(server, process.stdin, process.stdout)
    await Promise.all([http.close(), closeWebhooks(), session?.close(), features?.close()])
    return
  }

  const port = values.port === undefined ? DEFAULT_MCP_PORT : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log(`porta inválida: ${values.port}`)
    process.exitCode = 2
    return
  }
  const token = values.token ?? process.env['VVPOST_MCP_TOKEN']
  const running = await serveHttp(server, { port, ...(token && { token }), log })
  log(`workspace ${workspaceDir}`)
  log(`Streamable HTTP em ${running.url}/mcp e SSE em ${running.url}/sse${token ? ' (com token)' : ''}`)
  const stop = () => void running.close().then(() => Promise.all([http.close(), closeWebhooks(), session?.close(), features?.close()])).finally(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

/** O login corporativo do stdio: a URL vai para o log (o cliente de IA mostra) e o navegador padrão abre. */
function openInBrowser(log: (line: string) => void): (url: string) => Promise<void> {
  return async (url) => {
    log(`login corporativo do VVPost Enterprise: ${url}`)
    const [cmd, args] =
      // rundll32 no Windows: o cmd /c start interpretaria os & da query.
      process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
    try {
      spawn(cmd, args as string[], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref()
    } catch {
      // sem navegador: a URL ficou no log
    }
  }
}

main().catch((err: Error) => {
  process.stderr.write(`[vvpost-mcp] ${err.message}\n`)
  process.exitCode = 1
})
