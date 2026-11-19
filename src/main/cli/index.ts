import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { enclosingProjectDir, projectDir, projectLayout } from '@vvpost/core/projects'
import { plainFlows } from '@vvpost/core/flows/workspace'
import { dataFormatOf, parseDataFile } from '@vvpost/core/scenarios/data'
import { defaultUserDataDir, pluginLocations } from '@vvpost/core/paths'
import { createCoreSession, type CoreSession, type CoreSessionOptions } from '@vvpost/core/session'
import type { SharedConnector } from '@vvpost/core/connectors/shared'
import { createSecretSanitizer, type SecretSanitizer } from '@vvpost/core/sanitizer'
import type { PiiMasker } from '@vvpost/core/pii'
import type { HttpClientConfig } from '@vvpost/core/http/dispatcher'
import { CookieJar, type StoredCookie } from '@vvpost/core/http/cookies'
import type { ArchiveSummary, DocScope, ImportConflictMode } from '@shared/ipc'
import { exportAs, ExportError, type ExportFormat } from '../bundle/export'
import { prepareSources, prepareSpecReimport, previewImport, writeImport, type ImportSource } from '../importers'
import { fetchImportUrl, isUrl, readImportFile } from '../importers/source'
import { jsonReport, junitReport, prettyReport } from './reporters'
import { exitCode, runWorkspace, summarize, UsageError } from './run'
import { lazyWebhookServer, serveWebhooks } from './webhooks'
import { pluginCommand } from './plugin'
import { serveMock } from './mock'
import { readCatalogFile } from './catalog'
import { schemaCommand, SCHEMA_HELP } from './schema'
import { secretsCommand, SECRETS_HELP } from './vault-command'
import { loginCommand, LOGIN_HELP } from './login'
import { syncCommand } from './sync'
import { docsExportCommand, DOCS_EXPORT_HELP_OPTIONS } from './docs-export'
import { lintCommand, LINT_HELP_OPTIONS } from './lint'
import { applyCiValues, readSecretsFile, secretsFromProcessEnv, SECRET_ENV_PREFIX, type CiValues } from './secrets'
import { guardRepository, installPreCommitHook } from '../workspace/commit-guard'
import { describeLeaks } from '../workspace/leak-guard'
import { workspaceProblems } from '../workspace/problems'
import { FEATURE_IDS } from '@vvpost/core/policy/features'
import type { FeaturePolicySession } from '../enterprise/control-plane'
import { applyFeaturePolicy, openFeaturePolicy } from '../enterprise/features'
import { readOrganization } from '../enterprise/organization'
import { loadEnterpriseModule } from '../secret-engine/backend'

export const CLI_VERSION = '0.1.0'

const HELP = `VVPost CLI: roda os cenários de teste e os fluxos do workspace, para CI/CD, e importa e exporta pacotes.

Uso: vvpost <comando> [opções]

Comandos:
  run        Roda cenários e fluxos e sai com 0 (passou), 1 (falhou), 2 (configuração) ou 130 (interrompido)
  list       Lista conectores com cenários, ambientes e fluxos do workspace
  projects   Lista os projetos do workspace (subpastas com vvpost.project.json) e o Compartilhado
  migrate    Converte os conectores do formato antigo em fluxos (fluxo-base e um fluxo por endpoint), num
             lote só; --dry-run mostra os arquivos sem gravar, --connector limita, --json - em JSON
  doctor     O que impede o workspace de rodar, por ambiente e de uma vez: segredo sem valor, variável que o
             ambiente não define, URL inválida e API que não abre conexão (só TCP, nada é enviado). Com os
             segredos do CI aplicados; --env limita, --no-probe não abre conexão, --json - em JSON; sai com 2
             se houver bloqueio
  validate   Confere os arquivos do workspace (JSON, schemas, herança) e se a documentação acompanha as definições
             (diretivas e seções que apontam para o que não existe, corpo padrão fora do bodySchema, exemplo de
             resposta fora do schema dele, plugins de vvpost.plugins.json); sai com 2
             se algum tiver problema. Com --strict, corpo de cenário fora do schema e avisos também contam;
             com --lint, os erros do lint também reprovam (e os avisos dele aparecem)
  lint       Confere as regras de estilo e os erros comuns do projeto (descrição, exemplo, cenário, schema das
             respostas, segredos, caminhos), as do ruleset do time em .vvpost/ruleset.yaml (formato do Spectral,
             regras por JSONPath) e as de OpenAPI na spec exportada; texto, JSON, JUnit e SARIF; sai com 2 em erro
  export     Exporta o workspace (ou uma seleção) como pacote do VVPost, coleção do Postman ou spec OpenAPI,
             ou, com --format zip, a pasta do projeto ou do workspace inteiro num .vvpost.zip, sem nenhum valor
             de segredo
  import     Importa pacotes do VVPost, coleções/ambientes do Postman, specs OpenAPI/Swagger (arquivo ou URL),
             exportações do Insomnia, coleções do Bruno (pasta, .bru ou JSON), HAR e WSDL no workspace:
             vvpost import <arquivo | pasta | URL>...; vvpost import --reimport <conector> relê a spec dele.
             Um .zip do VVPost abre como workspace numa pasta vazia, ou entra como projeto no workspace
  docs       Gera a documentação rica em Markdown com diagramas Mermaid (projeto, conector, endpoint ou request);
             vvpost docs export grava a documentação como site HTML estático (ou no formato de um plugin)
  schema     Mostra e edita os campos do corpo de um endpoint (o formulário tipado): vvpost schema <conector>/<endpoint>
             (vvpost schema --help para as opções)
  webhooks   Liga o servidor local de webhooks até o Ctrl+C: mostra cada evento e roda os disparos dos hooks
  mock       Liga o mock server até o Ctrl+C: cada endpoint responde com os exemplos de resposta salvos nele
  guard      Confere o que está no index do Git (o próximo commit): nenhum valor do vault, credencial literal
             num conector ou fluxo, chave privada PEM ou arquivo de segredos locais; sai com 1 se achar.
             --all confere todos os arquivos versionados; --install instala como hook de pre-commit
  sync       A spec OpenAPI do código como fonte do contrato: relê a spec de cada conector vinculado e aplica
             o que mudou (a spec ganha nos campos de contrato; cenários, exemplos, docs, fluxos e ambientes
             ficam). --check só confere e sai com 1 se houver drift, para o CI; --link vincula um conector
  connect    Liga um repositório de código ao VVPost num passo: registra o servidor MCP nos clientes de IA
             (Claude Code, Cursor, Copilot, Codex) e grava a regra do VVPost no CLAUDE.md / AGENTS.md dele,
             para o agente atualizar a documentação junto com o código: vvpost connect <repositório>
  secrets    Os valores das variáveis secretas no cofre local, sem o app: vvpost secrets list, set <ambiente>
             <VAR> (o valor vem do prompt sem eco ou do stdin, nunca da linha de comando) e rm <ambiente> <VAR>
  login      VVPost Enterprise: registra a organização pelo endereço do Control Plane e confere o login;
             a configuração vem do Control Plane: vvpost login <url> [--project <projeto>]
  plugin     Para quem publica plugins: keygen, sign, pack e verify (vvpost plugin para os detalhes)

Opções de run:
  --workspace <pasta>   Workspace VVPost (padrão: $VVPOST_WORKSPACE ou a pasta atual). Dentro da pasta
                        de um projeto, vale o projeto, como o Git acha o repositório
  --project <id>        Projeto do workspace (padrão: $VVPOST_PROJECT); vale para todos os comandos
  --env <ids>           Ambientes, separados por vírgula ou repetindo a opção; "all" roda em todos.
                        Os cenários formam a matriz cenário × ambiente; cada fluxo roda uma vez por ambiente
  --connector <id>      Só os cenários deste conector (repetível)
  --scenario <filtro>   Só "<endpoint>" ou "<endpoint>/<cenário>" (repetível)
  --flow <id|arquivo>   Só este fluxo (repetível). Sem --connector nem --flow, roda tudo
  --secrets <arquivo>   Segredos num JSON { "<ambiente>": { "VAR": "valor" } }, além dos do cofre local
  --catalog <arquivo>   Conectores compartilhados, somente leitura (repetível): a resposta de
                        GET /api/v1/catalog do Control Plane, uma lista de conectores ou um conector.
                        Conectores do workspace herdam deles com "extends"
  --var <NOME=valor>    Troca o valor de uma variável em todo ambiente que a declara (repetível)
  --data <arquivo>      CSV com cabeçalho ou JSON (lista de objetos): os cenários rodam uma vez por linha,
                        com as colunas em {{coluna}} e {{$data.coluna}} e o número da linha em {{$iteration}}
  --junit <arquivo>     Grava o relatório JUnit XML
  --json <arquivo>      Grava o relatório JSON ("-" escreve no stdout no lugar da saída de texto)
  --quiet               Mostra só falhas e o resumo
  --no-color            Saída sem cores (também com $NO_COLOR)
  --strict              Arquivo inválido no workspace também é erro de configuração (código 2)
  --no-plugins          Não carrega plugins: nós de plugin falham com PLUGIN_UNAVAILABLE
  --history <nível>     Grava a execução no histórico do app: metadata, headers ou full (padrão: não grava)
  --history-db <arquivo> Banco do histórico (padrão: $VVPOST_HISTORY_DB ou o vvpost.db do app)
  --port <n>            Porta do servidor de webhooks, ligado só se um fluxo tem nó webhook
                        (padrão: a de .vvpost/webhooks.json, $VVPOST_WEBHOOK_PORT ou 4480)
  --proxy <url|off>     Proxy de todas as requisições (padrão: HTTPS_PROXY, HTTP_PROXY e NO_PROXY)
  --insecure            Não verifica o certificado TLS dos servidores
  --ca <arquivo>        CA extra em PEM, além das do sistema (repetível)
  --cookie-jar <arquivo> Lê e grava os cookies neste arquivo (sem ela, os cookies valem só nesta execução)

Segredos também chegam por variáveis ${SECRET_ENV_PREFIX}<VAR>, aplicadas a todo ambiente que declara VAR.
Nada é gravado no workspace, e os relatórios e a saída passam pelo Secret Sanitizer.

${LINT_HELP_OPTIONS}
Opções de export:
  --format <formato>    vvpost (padrão: o pacote, com cenários, ambientes, fluxos e docs), postman (coleção v2.1
                        e um ambiente do Postman por ambiente, gravados ao lado), openapi (spec 3.1; YAML se
                        --out terminar em .yaml ou .yml) ou zip (a pasta como está: dentro de um projeto, ou com
                        --project, o projeto; na raiz, o workspace inteiro com todos os projetos). A auth vai
                        como variáveis {{VAR}}; segredos vão vazios
  --connector <id>      Só este conector, com todos os endpoints (repetível)
  --endpoint <c/e>      Só o endpoint <e> do conector <c> (repetível)
  --env <ids>           Só estes ambientes (variáveis secretas vão como __REQUIRED_SECRET__)
  --flow <id>           Só este fluxo; os conectores que ele usa entram junto (repetível)
                        Sem nenhum filtro, exporta tudo. Os pais (extends) sempre entram junto
  --no-scenarios        Sem os cenários de teste
  --no-docs             Sem a documentação Markdown dos conectores
  --name <nome>         Nome do pacote
  --out <arquivo>       Onde gravar (padrão: <pasta>.vvpost.bundle.json, .postman_collection.json, .openapi.json ou
                        .vvpost.zip; "-" escreve no stdout só o arquivo principal)

Opções de import de um .zip do VVPost:
  --workspace <pasta>   Vazia (ou que ainda não existe): o zip abre ali como workspace. Com um workspace, o zip
                        de um projeto (ou de um workspace sem projetos) entra como projeto novo nele
  --as <id>             Id do projeto novo (padrão: o do zip); --name troca o nome

Opções de docs:
  --connector <id>      Documenta só este conector (sem filtro: o projeto inteiro)
  --endpoint <id>       Só este endpoint do conector ("<conector>/<endpoint>" dispensa --connector)
  --scenario <id>       Só esta request (cenário) do endpoint ("<endpoint>/<cenário>" dispensa --endpoint)
  init                  vvpost docs init: cria o modelo (vvpost.docs.json) e o documento do projeto (docs/projeto.md)
  --title <texto>       Com init: título do documento
  --template <id>       Com init: modelo de documentação (c4, arc42, diataxis, adr, api-guide ou um do projeto)
  templates             vvpost docs templates: lista os modelos (do VVPost e *.doc-template.vvpost.json do projeto)
  agents                vvpost docs agents: o trecho para CLAUDE.md / AGENTS.md que manda a IA documentar no VVPost;
                        com --out <arquivo>, acrescenta ao arquivo (uma vez só)
  --strict              Sai com 1 se o documento do projeto tiver diretiva com erro
  --generated           No projeto, a referência gerada mesmo com o documento do projeto (vvpost.docs.json)
  --out <arquivo>       Onde gravar (padrão: <pasta>.docs.md; "-" escreve no stdout)
                        Variáveis secretas aparecem só pelo nome; nenhum valor de segredo entra no documento

${DOCS_EXPORT_HELP_OPTIONS}
Opções de connect (vvpost connect [repositório], padrão: a pasta atual):
  --workspace, --project O workspace e o projeto que documentam o repositório (o servidor e a regra apontam para eles)
  --client <ids>        claude, cursor, vscode e/ou codex (padrão: os que o repositório e a máquina já usam;
                        nenhum: claude). Claude Code: claude mcp add --scope local; Cursor: .cursor/mcp.json;
                        Copilot: .vscode/mcp.json; Codex: codex mcp add. A regra vai no CLAUDE.md (Claude Code)
                        e no AGENTS.md (os outros)
  --http <url>          Usa o servidor HTTP do app (ex.: http://127.0.0.1:4470) no lugar de iniciar por stdio;
                        com $VVPOST_MCP_TOKEN definido, o cliente manda o token lido do ambiente
  --dry-run             Só diz o que faria
                        Idempotente: rodar de novo não duplica nada

Opções de webhooks (.vvpost/webhooks.json define os hooks; sem ele, aceita tudo):
  --port <n>            Porta (padrão: a do arquivo, $VVPOST_WEBHOOK_PORT ou 4480)
  --env <id>            Ambiente das assinaturas e dos disparos (padrão: o do arquivo ou o primeiro)
  --secrets, --var      Como no run: valores das chaves de assinatura e dos fluxos disparados
  --json -              Um evento por linha em JSON (NDJSON), sem headers nem corpo
                        Só aceita conexões locais; a saída passa pelo Secret Sanitizer

Opções de mock (o caminho é o basePath do conector + o path do endpoint):
  --port <n>            Porta (padrão: $VVPOST_MOCK_PORT ou 4490)
  --connector <id>      Só os endpoints deste conector (repetível; padrão: todos)
  --json -              Uma requisição por linha em JSON (NDJSON)
                        Escolha o exemplo com ?__example=<id>, ?__status=<código>, X-VVPost-Example ou
                        Prefer: code=<código>; sem pedido, o primeiro 2xx. Só aceita conexões locais

Opções de sync (vvpost sync [--check]; guia em docs/openapi-sync.md):
  --check               Não grava; sai com 1 se o VVPost difere da spec (2 se a spec não dá para ler)
  --fail-on <quando>    Com --check: drift (padrão: qualquer diferença) ou breaking (só endpoint removido de
                        que algo depende, ou validação que o sync quebraria)
  --connector <id>      Só a spec deste conector (repetível; padrão: todas as vinculadas)
  --link <arquivo|URL>  Vincula --connector a esta spec e sincroniza: endpoints com o método e o caminho de uma
                        operação passam a segui-la, sem duplicar
  --prune               Apaga os endpoints que saíram da spec (sem isso, ficam e contam como drift)
  --keep-edits          Endpoint editado no VVPost fica com a edição (padrão: a spec ganha)
  --dry-run             Mostra o que mudaria, sem gravar e sem falhar
  --json -              Relatório em JSON no stdout

Opções de guard:
  --all                 Todos os arquivos versionados, como estão no disco (no lugar do index)
  --install             Instala o hook de pre-commit no repositório (não sobrescreve um que não seja do VVPost)
  --json -              Resultado em JSON no stdout

Opções de import:
  --conflict <modo>     Para ids que já existem: merge (padrão; acrescenta só o que é novo), rename ou replace
  --dry-run             Só mostra o que mudaria
  --reimport <conector> Relê a spec OpenAPI de onde o conector veio (source.location) e mescla o que mudou
  --spec-wins           Na reimportação, endpoint editado no projeto e alterado na spec fica com a versão da spec
  --prune               Na reimportação, apaga os endpoints que saíram da spec
  --json -              Resultado em JSON no stdout

Outras opções:
  --help, -h            Mostra esta ajuda
  --version, -v         Mostra a versão
`

export interface Io {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: NodeJS.ProcessEnv
  cwd: string
  isTTY: boolean
  /** Pasta do app (onde fica plugins/); o CLI de produção usa a do out/main/cli.js. */
  appDir: string
  /** Comando que roda este CLI (executável e cli.js), para o hook de pre-commit sem `vvpost` no PATH. */
  self?: string[]
  signal?: AbortSignal
  /** Lê um valor secreto: no terminal, sem eco; num pipe, o stdin inteiro (sem a quebra final). */
  readSecret?: (prompt: string) => Promise<string>
  /** Para testes: abre a URL de login no lugar do navegador padrão. */
  openExternal?: (url: string) => Promise<void>
  /** Para testes: dispatcher no lugar do Undici. */
  http?: CoreSessionOptions['http']
}

const OPTIONS = {
  workspace: { type: 'string' },
  project: { type: 'string' },
  env: { type: 'string', multiple: true },
  connector: { type: 'string', multiple: true },
  scenario: { type: 'string', multiple: true },
  flow: { type: 'string', multiple: true },
  secrets: { type: 'string' },
  catalog: { type: 'string', multiple: true },
  var: { type: 'string', multiple: true },
  data: { type: 'string' },
  junit: { type: 'string' },
  sarif: { type: 'string' },
  ruleset: { type: 'string' },
  lint: { type: 'boolean' },
  fix: { type: 'boolean' },
  json: { type: 'string' },
  quiet: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  strict: { type: 'boolean' },
  'no-plugins': { type: 'boolean' },
  'no-probe': { type: 'boolean' },
  history: { type: 'string' },
  'history-db': { type: 'string' },
  endpoint: { type: 'string', multiple: true },
  'no-scenarios': { type: 'boolean' },
  'no-docs': { type: 'boolean' },
  generated: { type: 'boolean' },
  title: { type: 'string' },
  template: { type: 'string' },
  name: { type: 'string' },
  out: { type: 'string' },
  target: { type: 'string' },
  label: { type: 'string' },
  force: { type: 'boolean' },
  conflict: { type: 'string' },
  as: { type: 'string' },
  'dry-run': { type: 'boolean' },
  reimport: { type: 'string' },
  check: { type: 'boolean' },
  link: { type: 'string' },
  'keep-edits': { type: 'boolean' },
  'fail-on': { type: 'string' },
  'spec-wins': { type: 'boolean' },
  prune: { type: 'boolean' },
  port: { type: 'string' },
  key: { type: 'string' },
  proxy: { type: 'string' },
  insecure: { type: 'boolean' },
  ca: { type: 'string', multiple: true },
  'cookie-jar': { type: 'string' },
  set: { type: 'string' },
  remove: { type: 'string', multiple: true },
  required: { type: 'boolean' },
  description: { type: 'string' },
  enum: { type: 'string' },
  format: { type: 'string' },
  items: { type: 'string' },
  'from-body': { type: 'boolean' },
  file: { type: 'string' },
  clear: { type: 'boolean' },
  all: { type: 'boolean' },
  install: { type: 'boolean' },
  client: { type: 'string', multiple: true },
  http: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' }
} as const

const parse = (args: string[]) => parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true })
type Values = ReturnType<typeof parse>['values']

const splitList = (values: string[] | undefined) =>
  (values ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)

/** Roda o CLI e devolve o código de saída. Separado do processo para os testes. */
export async function main(argv: string[], io: Io): Promise<number> {
  let parsed
  try {
    parsed = parse(argv)
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\nUse vvpost --help para ver as opções.\n`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.version) {
    io.stdout(`vvpost ${CLI_VERSION}\n`)
    return 0
  }
  const command = positionals[0]
  if (command === 'schema' && values.help) {
    io.stdout(SCHEMA_HELP)
    return 0
  }
  if (command === 'login' && values.help) {
    io.stdout(LOGIN_HELP)
    return 0
  }
  if (command === 'secrets' && values.help) {
    io.stdout(SECRETS_HELP)
    return 0
  }
  if (values.help || !command || command === 'help') {
    io.stdout(HELP)
    return command || values.help ? 0 : 2
  }
  if (command === 'plugin') return pluginCommand(io, positionals.slice(1), values)
  // --project e --env aqui são do Control Plane, não do workspace.
  if (command === 'login') return loginCommand(io, positionals.slice(1), values, io.openExternal)
  if (positionals.length > (command === 'schema' || command === 'connect' ? 2 : 1) && command !== 'import' && command !== 'secrets' && !(command === 'docs' && ['init', 'templates', 'agents', 'export'].includes(positionals[1] ?? '') && positionals.length === 2)) {
    io.stderr(`vvpost: argumento inesperado "${positionals[1]}" (filtros vão em --connector, --scenario e --flow)\n`)
    return 2
  }
  if (!['run', 'list', 'projects', 'migrate', 'validate', 'doctor', 'lint', 'export', 'import', 'sync', 'docs', 'schema', 'webhooks', 'mock', 'guard', 'connect', 'secrets'].includes(command)) {
    io.stderr(`vvpost: comando desconhecido "${command}" (use run, list, projects, migrate, validate, lint, export, import, sync, docs, schema, webhooks, mock, guard, connect, secrets, login ou plugin)\n`)
    return 2
  }
  const portText = values.port ?? io.env[command === 'mock' ? 'VVPOST_MOCK_PORT' : 'VVPOST_WEBHOOK_PORT']
  const port = portText === undefined ? undefined : Number(portText)
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    io.stderr(`vvpost: porta inválida: ${portText}\n`)
    return 2
  }

  const folder = resolve(io.cwd, values.workspace ?? io.env['VVPOST_WORKSPACE'] ?? '.')
  // Um .zip do VVPost abre como workspace numa pasta que ainda não existe.
  if (command === 'import' && positionals.slice(1).some(isZip) && !existsSync(folder)) mkdirSync(folder, { recursive: true })
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    io.stderr(`vvpost: workspace não encontrado: ${folder}\n`)
    return 2
  }
  // Com --project, a pasta do projeto no workspace; sem, o projeto que contém a pasta, se houver.
  let workspaceDir: string
  const projectId = values.project ?? io.env['VVPOST_PROJECT']
  try {
    workspaceDir = projectId ? projectDir(enclosingProjectDir(folder) ?? folder, projectId) : (enclosingProjectDir(folder) ?? folder)
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\n`)
    return 2
  }
  if (command === 'projects') return projectsCommand(workspaceDir, io, values.json === '-')
  if (command === 'secrets') return secretsCommand(workspaceDir, io, positionals.slice(1), values.json === '-')
  if (command === 'connect') return connectCommand(workspaceDir, io, values, positionals[1])
  if (command === 'guard') return guardCommand(workspaceDir, io, values)
  if (command === 'migrate') return migrateCommand(workspaceDir, io, values)

  if (command === 'export') return exportCommand(workspaceDir, io, values)
  if (command === 'import' && positionals.slice(1).some(isZip)) return importArchiveCommand(folder, workspaceDir, io, values, positionals.slice(1))
  if (command === 'import') return importCommand(workspaceDir, io, values, positionals.slice(1))
  if (command === 'sync') return syncCommand(workspaceDir, io, values)
  if (command === 'lint') return lintCommand(workspaceDir, io, values, CLI_VERSION)
  if (command === 'docs') {
    if (positionals[1] === 'init') return docsInitCommand(workspaceDir, io, values)
    if (positionals[1] === 'templates') return docsTemplatesCommand(workspaceDir, io)
    if (positionals[1] === 'agents') return docsAgentsCommand(io, values)
    if (positionals[1] === 'export') {
      return docsExportCommand(workspaceDir, io, values, {
        generator: `vvpost CLI ${CLI_VERSION}`,
        plugins: values['no-plugins'] ? null : pluginLocations(io.appDir, defaultUserDataDir(io.env))
      })
    }
    return docsCommand(workspaceDir, io, values)
  }
  if (command === 'schema') return schemaCommand(workspaceDir, io, values, positionals[1])

  // Daqui para baixo algo roda: os recursos que a organização desligou valem (enterprise/features.ts).
  let features: FeaturePolicySession | null
  try {
    features = await cliFeaturePolicy(workspaceDir, io)
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\n`)
    return 2
  }
  try {
    return await execute()
  } finally {
    await features?.close()
    applyFeaturePolicy(null)
  }

  async function execute(): Promise<number> {
    if (command === 'mock') {
      try {
        return await serveMock(workspaceDir, io, { ...(port !== undefined && { port }), connectors: splitList(values.connector), json: values.json === '-' })
      } catch (err) {
        io.stderr(`vvpost: ${(err as Error).message}\n`)
        return 2
      }
    }

    let ci: CiValues
    let shared: SharedConnector[] | undefined
    try {
      if (values.catalog?.length) {
        shared = []
        for (const path of values.catalog) shared.push(...(await readCatalogFile(resolve(io.cwd, path))))
      }
      ci = {
        env: secretsFromProcessEnv(io.env),
        vars: parseVars(values.var),
        ...(values.secrets !== undefined && { file: await readSecretsFile(resolve(io.cwd, values.secrets)) })
      }
    } catch (err) {
      io.stderr(`vvpost: ${(err as Error).message}\n`)
      return 2
    }

    const historyLevel = values.history ?? (values['history-db'] !== undefined ? 'headers' : undefined)
    if (historyLevel !== undefined && !['off', 'metadata', 'headers', 'full'].includes(historyLevel)) {
      io.stderr(`vvpost: --history ${historyLevel}: use metadata, headers, full ou off\n`)
      return 2
    }
    const record = historyLevel !== undefined && historyLevel !== 'off' && command === 'run'

    let client: HttpClientConfig
    let saveCookies = async () => {}
    try {
      ;({ client, saveCookies } = await cliClientConfig(values, io))
    } catch (err) {
      io.stderr(`vvpost: ${(err as Error).message}\n`)
      return 2
    }

    const sanitizer = createSecretSanitizer()
    const webhooks =
      command === 'run'
        ? lazyWebhookServer(workspaceDir, {
            ...(port !== undefined && { port }),
            workspace: () => core.load(),
            log: (line) => io.stderr(`${line}\n`)
          })
        : undefined
    // Os valores do CI são credenciais mesmo quando a variável não está marcada isSecret no ambiente.
    for (const value of Object.values(ci.env)) sanitizer.add(value)
    for (const vars of Object.values(ci.file ?? {})) for (const value of Object.values(vars)) sanitizer.add(value)
    const core = createCoreSession({
      workspaceDir,
      sanitizer,
      onLoad: (ws) => applyCiValues(ws, ci),
      ...(shared && { shared }),
      ...(io.http && { http: io.http }),
      client,
      ...(record && { record: { enabled: true, maxBody: HISTORY_BODY_LIMIT } }),
      ...(webhooks && { webhooks: webhooks.inbox }),
      // Com uma pessoa no terminal, o OAuth2 authorization_code abre o login no navegador; no CI, nunca.
      ...(io.isTTY && !io.env['CI'] && { authHooks: { openBrowser: (url: string) => openInBrowser(url, io) } }),
      ...(!values['no-plugins'] && { plugins: pluginLocations(io.appDir, defaultUserDataDir(io.env)) })
    })
    try {
      if (command === 'list') return await list(core, io, values.json === '-')
      if (command === 'doctor') {
        const { doctor } = await import('./doctor')
        return await doctor(() => core.load(), (t) => sanitizer.text(t), io, {
          environmentIds: splitList(values.env),
          json: values.json === '-',
          probe: !values['no-probe'],
          ...(client.proxy && { proxy: client.proxy })
        })
      }
      if (command === 'validate') return await validate(core, io, values.strict === true, values.lint === true ? { ...(values.ruleset && { ruleset: resolve(io.cwd, values.ruleset) }) } : undefined)
      if (command === 'webhooks') {
        const env = splitList(values.env)
        if (env.length > 1) throw new UsageError('--env: o servidor de webhooks usa um ambiente só')
        return await serveWebhooks(core, sanitizer, io, {
          ...(port !== undefined && { port }),
          ...(env[0] !== undefined && { environment: env[0] }),
          json: values.json === '-'
        })
      }
      return await run(core, sanitizer, io, values)
    } catch (err) {
      if (err instanceof UsageError) {
        io.stderr(`vvpost: ${sanitizer.text(err.message)}\n`)
        return 2
      }
      io.stderr(`vvpost: ${sanitizer.text((err as Error).stack ?? String(err))}\n`)
      return 2
    } finally {
      await webhooks?.close()
      await core.close()
      await saveCookies().catch((err: Error) => io.stderr(`vvpost: --cookie-jar: ${err.message}\n`))
    }
  }
}

/**
 * A política de recursos da organização para os comandos que executam (run, validate, list, mock,
 * webhooks). Sem login aberto, vale a última política gravada nesta máquina; sem nenhuma, com a
 * organização declarada, os recursos da lista ficam desligados e o aviso diz como resolver.
 */
async function cliFeaturePolicy(workspaceDir: string, io: Io): Promise<FeaturePolicySession | null> {
  const declared = await readOrganization([...new Set([workspaceDir, enclosingProjectDir(workspaceDir) === workspaceDir ? dirname(workspaceDir) : workspaceDir])])
  const session = await openFeaturePolicy({ surface: 'cli' }, () => loadEnterpriseModule(io.env), declared)
  applyFeaturePolicy(session)
  const state = await session?.ready()
  if (state?.status === 'unavailable') {
    io.stderr(`vvpost: política da organização indisponível (${state.reason}); ${FEATURE_IDS.join(', ')} ficam desligados. Rode vvpost login <url do Control Plane> para lê-la.\n`)
  }
  return session
}

/** `--data`: o arquivo de iterações, CSV ou JSON pela extensão. */
async function readDataFile(path: string): Promise<{ name: string; rows: Record<string, string>[] }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    throw new UsageError(`--data: não foi possível ler ${path}: ${(err as Error).message}`)
  }
  try {
    const { rows } = parseDataFile(text, dataFormatOf(path))
    return { name: basename(path), rows }
  } catch (err) {
    throw new UsageError(`--data ${basename(path)}: ${(err as Error).message}`)
  }
}

function parseVars(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of values ?? []) {
    const eq = entry.indexOf('=')
    if (eq <= 0) throw new Error(`--var ${entry}: use NOME=valor`)
    out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}

async function run(core: CoreSession, sanitizer: SecretSanitizer, io: Io, values: Values): Promise<number> {
  const data = values.data === undefined ? undefined : await readDataFile(resolve(io.cwd, values.data))
  // Plugins fora do vvpost.plugins.json (ou que faltam) param antes de qualquer requisição, com o
  // motivo; numa execução filtrada, só os declarados contam.
  const filtered = splitList(values.connector).length > 0 || (values.flow ?? []).length > 0
  const plugins = await core.pluginProblems(await core.load(), await core.loadFlows(), { declaredOnly: filtered })
  if (plugins.length) {
    io.stderr(`vvpost: plugins do workspace:\n${plugins.map((p) => `  ${p}\n`).join('')}`)
    return 2
  }
  // A máscara para pessoas (privacy.json ou a organização) é decidida antes de qualquer requisição:
  // um privacy.json inválido para aqui, em vez de mostrar os dados.
  let pii: PiiMasker | null
  try {
    pii = await cliPeopleMasker(core)
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\n`)
    return 2
  }
  const result = await runWorkspace(
    core,
    {
      connectors: splitList(values.connector),
      flows: values.flow ?? [],
      scenarios: splitList(values.scenario),
      environments: splitList(values.env),
      ...(data && { data })
    },
    io.signal
  )
  // Tudo que sai do processo (terminal, artefatos do CI) passa pelo sanitizer, como as respostas do MCP,
  // e, com a máscara para pessoas ligada, pelo mascaramento de PII.
  let safe = sanitizer.sanitize(result)
  if (pii) {
    const view = await import('@vvpost/core/pii-people')
    safe = {
      ...safe,
      scenarios: safe.scenarios.map((r) => view.peopleScenarioReport(r, pii)),
      flows: safe.flows.map((f) => ({ ...f, report: view.peopleFlowReport(f.report, pii) }))
    }
  }
  const summary = summarize(safe)
  if (values.strict && safe.issues.length && summary.outcome !== 'canceled') summary.outcome = 'error'

  const color = io.isTTY && !values['no-color'] && io.env['NO_COLOR'] === undefined
  if (values.json !== '-') io.stdout(sanitizer.text(prettyReport(safe, summary, { color, quiet: !!values.quiet })))
  const write = async (path: string, text: string) => {
    const target = resolve(io.cwd, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, sanitizer.text(text))
  }
  if (values.json === '-') io.stdout(sanitizer.text(jsonReport(safe, summary)))
  else if (values.json !== undefined) await write(values.json, jsonReport(safe, summary))
  if (values.junit !== undefined) await write(values.junit, junitReport(safe))
  if (values.history !== undefined || values['history-db'] !== undefined) await saveHistory(core, sanitizer, io, values, result, summary, pii)
  return exitCode(summary)
}

/** O mascaramento de dados pessoais para pessoas no vvpost run, ou null (docs/security-model.md). */
async function cliPeopleMasker(core: CoreSession): Promise<PiiMasker | null> {
  const [ws, { peopleMasker }, { featureDenial }] = await Promise.all([core.load(), import('@vvpost/core/pii'), import('@vvpost/core/policy/features')])
  return peopleMasker(ws, [ws.dir, ...(ws.root ? [ws.root] : [])], featureDenial('piiVisible') !== null)
}

/** Corpo guardado por requisição no histórico do CLI (o padrão do app). */
const HISTORY_BODY_LIMIT = 256 * 1024

/**
 * `--history`: a execução vai para o mesmo banco SQLite do app (ou `--history-db`), com as
 * requisições de todos os lotes e fluxos, mascaradas pelo mesmo sanitizer da saída. Uma
 * falha aqui avisa no stderr e não muda o código de saída.
 */
async function saveHistory(
  core: CoreSession,
  sanitizer: SecretSanitizer,
  io: Io,
  values: Values,
  result: Awaited<ReturnType<typeof runWorkspace>>,
  summary: ReturnType<typeof summarize>,
  pii: PiiMasker | null
): Promise<void> {
  const level = (values.history ?? 'headers') as 'off' | 'metadata' | 'headers' | 'full'
  if (level === 'off') return
  const path = values['history-db'] !== undefined
    ? resolve(io.cwd, values['history-db'])
    : (io.env['VVPOST_HISTORY_DB'] ?? join(defaultUserDataDir(io.env), 'vvpost.db'))
  const title = ['vvpost run', ...splitList(values.connector), ...(values.flow ?? []), ...(result.environments.length ? [`--env ${result.environments.join(',')}`] : [])].join(' ')
  try {
    await mkdir(dirname(path), { recursive: true })
    const [{ openHistoryStore }, { cliRun }] = await Promise.all([import('../history/store'), import('../history/record')])
    const store = await openHistoryStore(path)
    try {
      await store.addRun(cliRun(result, summary, core.takeRecorded('cli'), title), { sanitizer, level, ...(pii && { pii }) })
    } finally {
      await store.close()
    }
  } catch (err) {
    io.stderr(`vvpost: não foi possível gravar o histórico em ${path}: ${sanitizer.text((err as Error).message)}\n`)
  }
}

async function migrateCommand(dir: string, io: Io, values: Values): Promise<number> {
  const only = splitList(values.connector)
  const { migrateWorkspace } = await import('../project/migrate')
  const { plan, result } = await migrateWorkspace(dir, { dryRun: !!values['dry-run'], ...(only.length && { connectors: only }) })
  const changes = (result?.changes ?? []).map(({ path, action }) => ({ path, action }))
  const errors = result?.errors ?? []
  if (values.json === '-') {
    io.stdout(`${JSON.stringify({ dryRun: !!values['dry-run'], ok: !errors.length, converted: plan.converted, schemas: plan.schemas, skipped: plan.skipped, changes, errors }, null, 2)}\n`)
    return errors.length ? 2 : 0
  }
  for (const e of errors) io.stderr(`vvpost: ${e.message}\n`)
  if (errors.length) {
    io.stderr('vvpost: nada foi gravado\n')
    return 2
  }
  const verb = { create: 'cria', update: 'muda', delete: 'apaga' } as const
  const out: string[] = []
  if (plan.converted.length) out.push(`${values['dry-run'] ? 'Converteria' : 'Convertidos'} ${plan.converted.length} conector(es).`)
  else out.push('Nenhum conector para converter.')
  if (plan.schemas.length) {
    const list = plan.schemas.map((s) => `${s.name} (${s.uses} cópias)`).join(', ')
    out.push(`${values['dry-run'] ? 'Compartilharia' : 'Compartilhados'} ${plan.schemas.length} schema(s) repetido(s) em schemas/: ${list}.`)
  }
  if (changes.length) out.push('Arquivos:', ...changes.map((c) => `  ${verb[c.action]} ${c.path}`))
  if (plan.skipped.length) out.push('', 'Ficam no formato antigo:', ...plan.skipped.map((s) => `  ${s.id}${s.file ? ` (${s.file})` : ''}: ${s.reason}`))
  io.stdout(`${out.join('\n')}\n`)
  return 0
}

function projectsCommand(dir: string, io: Io, asJson: boolean): number {
  const layout = projectLayout(dir)
  const current = layout.current?.id ?? null
  if (asJson) {
    io.stdout(`${JSON.stringify({ workspace: layout.root, current, projects: layout.projects, issues: layout.issues }, null, 2)}\n`)
    return 0
  }
  const out = [`Workspace ${layout.root}`, '']
  if (!layout.projects.length) out.push('Sem projetos: o workspace é um projeto só (crie uma subpasta com vvpost.project.json para separar).')
  else {
    out.push('Projetos:')
    for (const p of layout.projects) {
      const ref = p.reference ? `, referência só para leitura: ${[p.reference.workspace, p.reference.openapi].filter(Boolean).join(' ou ')}` : ''
      out.push(`  ${p.id === current ? '*' : ' '} ${p.id}  ${p.name}  (${p.folder}/${ref})`)
    }
    out.push(`  ${current ? ' ' : '*'} Compartilhado  (o resto da pasta, visível em todos os projetos)`)
  }
  if (layout.issues.length) out.push('', 'Arquivos ignorados:', ...layout.issues.map((i) => `  ${i.file}: ${i.message}`))
  io.stdout(`${out.join('\n')}\n`)
  return 0
}

async function list(core: CoreSession, io: Io, asJson: boolean): Promise<number> {
  const ws = await core.load()
  const flows = await core.loadFlows()
  const connectors = [...ws.connectors.keys()].sort().map((id) => {
    try {
      const resolved = resolveConnector(id, ws.connectors)
      const scenarios = resolved.endpoints.flatMap((e) => (e.scenarios ?? []).map((s) => `${e.id}/${s.id}`))
      return { id, name: resolved.name, file: ws.connectorFiles.get(id)!, scenarios }
    } catch (err) {
      return { id, name: ws.connectors.get(id)!.name, file: ws.connectorFiles.get(id)!, scenarios: [], error: (err as Error).message }
    }
  })
  const environments = [...ws.environments.values()].map((e) => ({ id: e.id, name: e.name }))
  const flowList = plainFlows(flows, ws.flowSources).map((f) => ({ id: f.flow.id, name: f.flow.name, file: f.file, nodes: f.flow.nodes.length }))
  const issues = [...ws.issues, ...flows.issues]
  if (asJson) {
    io.stdout(
      `${JSON.stringify({ workspace: ws.dir, ...(ws.project && { project: ws.project.id }), connectors, environments, flows: flowList, issues }, null, 2)}\n`
    )
    return 0
  }
  const out = [`Workspace ${ws.dir}${ws.project ? `  (projeto ${ws.project.id})` : ''}`, '', 'Conectores:']
  for (const c of connectors) {
    out.push(`  ${c.id}  ${c.scenarios.length} cenários  (${c.file})${c.error ? `  erro: ${c.error}` : ''}`)
    for (const s of c.scenarios) out.push(`    ${s}`)
  }
  if (!connectors.length) out.push('  (nenhum)')
  out.push('', 'Ambientes:', ...(environments.length ? environments.map((e) => `  ${e.id}  ${e.name}`) : ['  (nenhum)']))
  out.push('', 'Fluxos:', ...(flowList.length ? flowList.map((f) => `  ${f.id}  ${f.nodes} nós  (${f.file})`) : ['  (nenhum)']))
  if (issues.length) out.push('', 'Arquivos ignorados:', ...issues.map((i) => `  ${i.file}: ${i.message}`))
  io.stdout(`${out.join('\n')}\n`)
  return 0
}

/**
 * Confere o workspace como o CI precisa: JSON, schemas e herança, e também o que deixaria a
 * documentação para trás (docs/architecture.md, "Uma definição só"): seção {#id} do .md de um
 * conector sem endpoint, diretiva do documento do projeto apontando para o que não existe e
 * corpo padrão fora do bodySchema. Corpo de cenário fora do schema é só aviso (teste negativo
 * manda corpo inválido de propósito), e com --strict também conta.
 */
/**
 * vvpost guard: o leak guard do commit pelo app (leak-guard.ts) para commits feitos fora dele,
 * no terminal, na IDE ou como hook de pre-commit. Sai com 1 se achar segredo e 2 sem Git.
 */
async function guardCommand(workspaceDir: string, io: Io, values: Values): Promise<number> {
  const json = values.json === '-'
  try {
    if (values.install) {
      const r = await installPreCommitHook(workspaceDir, io.self ?? null)
      const said = { installed: 'instalado', updated: 'atualizado', unchanged: 'já estava instalado' }[r.status]
      if (json) io.stdout(`${JSON.stringify(r)}\n`)
      else io.stdout(`Hook de pre-commit ${said}: ${r.file}\nCada commit, de qualquer ferramenta, passa pelo vvpost guard.\n`)
      return 0
    }
    const r = await guardRepository(workspaceDir, { all: values.all === true })
    if (json) io.stdout(`${JSON.stringify({ ok: !r.leaks.length, checked: r.checked.length, leaks: r.leaks })}\n`)
    else if (r.leaks.length) io.stderr(`${describeLeaks(r.leaks)}\n`)
    else io.stdout(`vvpost guard: ${r.checked.length} ${r.checked.length === 1 ? 'arquivo conferido' : 'arquivos conferidos'}, nenhum segredo.\n`)
    return r.leaks.length ? 1 : 0
  } catch (err) {
    io.stderr(`vvpost guard: ${(err as Error).message}\n`)
    return 2
  }
}

async function validate(core: CoreSession, io: Io, strict = false, lint?: { ruleset?: string }): Promise<number> {
  const ws = await core.load()
  const flows = await core.loadFlows()
  const { problems, warnings } = await workspaceProblems(ws, flows, strict)
  for (const message of await core.pluginProblems(ws, flows)) problems.push({ file: 'plugins', message })
  if (lint) {
    // O lint lê os arquivos como estão (sem os valores do CI), como o vvpost lint.
    const [{ lintWorkspace }, { RulesetError }] = await Promise.all([import('../lint'), import('@vvpost/core/lint')])
    try {
      const result = await lintWorkspace(ws.dir, lint)
      for (const issue of result.issues) warnings.push({ file: result.ruleset ?? 'lint', message: issue })
      for (const f of result.findings) {
        if (f.severity !== 'error' && f.severity !== 'warn') continue
        const issue = { file: `${f.file}${f.line !== undefined ? `:${f.line}` : ''}`, message: `[${f.code}] ${f.label ? `${f.label}: ` : ''}${f.message}` }
        ;(f.severity === 'error' ? problems : warnings).push(issue)
      }
    } catch (err) {
      if (!(err instanceof RulesetError)) throw err
      problems.push({ file: 'lint', message: err.message })
    }
  }
  for (const p of problems) io.stderr(`${p.file}: ${p.message}\n`)
  for (const w of warnings) io.stderr(`aviso: ${w.file}: ${w.message}\n`)
  io.stdout(
    problems.length
      ? `${problems.length} problema(s) no workspace ${ws.dir}\n`
      : `Workspace ok: ${ws.connectors.size} conectores, ${ws.environments.size} ambientes, ${flows.flows.length} fluxos\n`
  )
  return problems.length ? 2 : 0
}

async function exportCommand(dir: string, io: Io, values: Values): Promise<number> {
  if (values.format === 'zip') return exportArchiveCommand(dir, io, values)
  const format = (values.format ?? 'vvpost') as ExportFormat
  if (!['vvpost', 'postman', 'openapi'].includes(format)) {
    io.stderr(`vvpost: --format "${format}" (use vvpost, postman, openapi ou zip)\n`)
    return 2
  }
  const filters = {
    connectors: splitList(values.connector),
    endpoints: splitList(values.endpoint),
    environments: splitList(values.env),
    flows: splitList(values.flow)
  }
  const partial = Object.values(filters).some((l) => l.length)
  try {
    const result = await exportAs(
      dir,
      {
        format,
        ...(partial && filters),
        ...(values['no-scenarios'] && { scenarios: false }),
        ...(values['no-docs'] && { docs: false })
      },
      { name: values.name ?? basename(dir), generator: `vvpost CLI ${CLI_VERSION}`, yaml: /\.ya?ml$/i.test(values.out ?? '') }
    )
    for (const w of result.warnings) io.stderr(`aviso: ${w}\n`)
    const [main, ...extra] = result.files
    if (values.out === '-') {
      if (extra.length) io.stderr(`aviso: ${extra.length} ambiente(s) do Postman não vão para o stdout; use --out <arquivo>\n`)
      io.stdout(main.text)
      return 0
    }
    const target = resolve(io.cwd, values.out ?? `${basename(dir)}${main.suffix}`)
    // Os ambientes do Postman vão ao lado da coleção, com o mesmo começo de nome.
    const stem = target.endsWith(main.suffix) ? target.slice(0, -main.suffix.length) : target.replace(/\.json$/i, '')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, main.text)
    for (const f of extra) await writeFile(`${stem}${f.suffix}`, f.text)
    const s = result.summary
    const what =
      format === 'vvpost'
        ? `${s.connectors} conectores, ${s.endpoints} endpoints, ${s.scenarios} cenários, ${s.environments} ambientes, ${s.flows} fluxos, ${s.docs} documentações`
        : `${s.connectors} conectores, ${s.endpoints} endpoints` + (extra.length ? `, ${extra.length} ambiente(s) do Postman ao lado` : '')
    const label = format === 'vvpost' ? 'Pacote gravado' : format === 'postman' ? 'Coleção do Postman gravada' : 'Spec OpenAPI gravada'
    io.stdout(`${label} em ${target}: ${what}\n`)
    for (const f of extra) io.stdout(`  ${stem}${f.suffix}\n`)
    return 0
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\n`)
    return err instanceof ExportError ? 1 : 2
  }
}

const isZip = (file: string) => /\.zip$/i.test(file)

const archiveCounts = (s: ArchiveSummary) =>
  [
    s.projects && `${s.projects} projeto(s)`,
    `${s.connectors} conectores`,
    `${s.flows} fluxos`,
    `${s.environments} ambientes`,
    `${s.docs} Markdown`,
    `${s.files} arquivos`
  ]
    .filter(Boolean)
    .join(', ')

/** vvpost export --format zip: a pasta do projeto (ou do workspace inteiro, na raiz) num .vvpost.zip. */
async function exportArchiveCommand(dir: string, io: Io, values: Values): Promise<number> {
  const filters = ['connector', 'endpoint', 'env', 'flow'] as const
  const used = filters.find((f) => values[f]?.length)
  if (used || values['no-scenarios'] || values['no-docs']) {
    io.stderr(`vvpost: --format zip leva a pasta inteira; --${used ?? (values['no-scenarios'] ? 'no-scenarios' : 'no-docs')} vale só para o pacote, o Postman e o OpenAPI\n`)
    return 2
  }
  const { exportArchive, ArchiveExportError, ARCHIVE_SUFFIX } = await import('../bundle/archive')
  try {
    const result = await exportArchive(dir, 'project', { ...(values.name && { name: values.name }), generator: `vvpost CLI ${CLI_VERSION}` })
    for (const w of result.warnings) io.stderr(`aviso: ${w}\n`)
    const target = resolve(io.cwd, values.out ?? `${basename(result.folder)}${ARCHIVE_SUFFIX}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, result.data)
    const what = result.manifest.kind === 'project' ? `projeto ${result.manifest.project?.id ?? result.manifest.name}` : 'workspace'
    io.stdout(
      `Zip do ${what} gravado em ${target}: ${archiveCounts(result.summary)}` +
        (result.summary.pendingSecrets ? `; ${result.summary.pendingSecrets} segredo(s) sem valor` : '') +
        '\n'
    )
    return 0
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\n`)
    return err instanceof ArchiveExportError && err.leak ? 1 : 2
  }
}

/**
 * vvpost import <zip>: numa pasta vazia, abre como workspace; num workspace, entra como projeto
 * novo (--as troca o id, --name o nome). Nada que já existe é sobrescrito.
 */
async function importArchiveCommand(folder: string, dir: string, io: Io, values: Values, files: string[]): Promise<number> {
  if (files.length !== 1) {
    io.stderr('vvpost: importe um .zip por vez, sem outros arquivos junto\n')
    return 2
  }
  const archive = await import('../bundle/archive')
  try {
    const file = resolve(io.cwd, files[0]!)
    const read = archive.readWorkspaceArchive(await readFile(file), basename(file))
    const empty = readdirSync(folder).length === 0
    const wanted = { ...(values.as && { id: values.as }), ...(values.name && { name: values.name }) }
    let plan: { mode: 'workspace' | 'project'; dir: string }
    if (empty) plan = { mode: 'workspace', dir: folder }
    else {
      const target = archive.projectTarget(read, projectLayout(dir).root, wanted)
      if (target.blocked) throw new Error(`${target.blocked} (numa pasta vazia: --workspace <pasta nova>)`)
      if (target.taken) throw new Error(`${target.taken}; use --as <outro-id>`)
      plan = { mode: 'project', dir: join(projectLayout(dir).root, target.id) }
    }
    if (values['dry-run']) {
      for (const w of read.warnings) io.stderr(`aviso: ${w}\n`)
      io.stdout(
        `Mudaria: ${plan.mode === 'workspace' ? 'workspace novo' : 'projeto novo'} em ${plan.dir}: ${archiveCounts(read.summary)}\n`
      )
      return 0
    }
    const result =
      plan.mode === 'workspace' ? await archive.importArchiveAsWorkspace(read, folder) : await archive.importArchiveAsProject(read, dir, wanted)
    for (const w of result.warnings) io.stderr(`aviso: ${w}\n`)
    io.stdout(
      [
        `${plan.mode === 'workspace' ? 'Workspace aberto do zip' : 'Projeto importado do zip'} em ${result.dir}: ${archiveCounts(read.summary)}`,
        ...(result.pendingSecrets ? [`${result.pendingSecrets} segredo(s) sem valor: preencha no módulo Secrets do app ou passe ${SECRET_ENV_PREFIX}<VAR> no CI`] : [])
      ].join('\n') + '\n'
    )
    return 0
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\nvvpost: nada foi gravado\n`)
    return 2
  }
}

/** Escopo do vvpost docs: --connector, --endpoint e --scenario, com as formas curtas c/e e e/s. */
function docsScope(values: Values): DocScope {
  const one = (name: 'connector' | 'endpoint' | 'scenario') => {
    const list = splitList(values[name])
    if (list.length > 1) throw new UsageError(`--${name}: o docs documenta um item por vez`)
    return list[0]
  }
  let connector = one('connector')
  let endpoint = one('endpoint')
  let scenario = one('scenario')
  if (endpoint?.includes('/')) {
    const at = endpoint.lastIndexOf('/')
    connector ??= endpoint.slice(0, at)
    endpoint = endpoint.slice(at + 1)
  }
  if (scenario?.includes('/')) {
    const at = scenario.lastIndexOf('/')
    endpoint ??= scenario.slice(0, at)
    scenario = scenario.slice(at + 1)
  }
  if (scenario && !endpoint) throw new UsageError('--scenario precisa do endpoint: --endpoint <id> ou --scenario <endpoint>/<cenário>')
  if (endpoint && !connector) throw new UsageError('--endpoint precisa do conector: --connector <id> ou --endpoint <conector>/<endpoint>')
  if (scenario) return { kind: 'request', connectorId: connector!, endpointId: endpoint!, scenarioId: scenario }
  if (endpoint) return { kind: 'endpoint', connectorId: connector!, endpointId: endpoint }
  if (connector) return { kind: 'connector', connectorId: connector }
  return { kind: 'project' }
}

async function docsCommand(dir: string, io: Io, values: Values): Promise<number> {
  try {
    const scope = docsScope(values)
    const [{ loadWorkspace }, { loadFlows }, docs] = await Promise.all([
      import('@vvpost/core/connectors/workspace'),
      import('@vvpost/core/flows/workspace'),
      import('@vvpost/core/docs')
    ])
    const ws = await loadWorkspace(dir)
    const flows = await loadFlows(dir)
    const options = { projectName: basename(dir), generator: `vvpost CLI ${CLI_VERSION}` }
    const { document, markdown: reference } = await docs.generateDocumentation(ws, flows, scope, options)
    for (const i of document.issues) io.stderr(`aviso: ${i.file}: ${i.message}\n`)
    // O documento do projeto (docs/projeto.md, com o modelo do vvpost.docs.json) é a documentação do projeto.
    let markdown = reference
    let failed = false
    if (scope.kind === 'project' && !values.generated) {
      const project = await docs.loadDocsProject(dir)
      for (const i of project.configIssues) io.stderr(`aviso: ${i.file}: ${i.message}\n`)
      if (project.source !== null) {
        const composed = await docs.composeDocumentation(ws, flows, {
          ...options,
          source: project.source,
          sourceFile: project.sourceFile,
          config: project.config
        })
        for (const d of composed.diagnostics) io.stderr(`${d.severity === 'error' ? 'erro' : 'aviso'}: ${d.file}:${d.line}: ${d.message}\n`)
        markdown = composed.markdown
        failed = values.strict === true && composed.diagnostics.some((d) => d.severity === 'error')
      }
    }
    if (values.out === '-') {
      io.stdout(markdown)
      return failed ? 1 : 0
    }
    const target = resolve(io.cwd, values.out ?? `${basename(dir)}.docs.md`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, markdown)
    const endpoints = document.connectors.reduce((n, c) => n + c.endpoints.length, 0)
    io.stdout(`Documentação (${document.scopeLabel.toLowerCase()}) gravada em ${target}: ${document.connectors.length} conector(es), ${endpoints} endpoint(s)\n`)
    return failed ? 1 : 0
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\n`)
    return 2
  }
}

/** vvpost docs templates: os modelos de documentação que o init e o editor do app oferecem. */
async function docsTemplatesCommand(dir: string, io: Io): Promise<number> {
  const docs = await import('@vvpost/core/docs')
  const { templates, issues } = await docs.listDocTemplates(dir)
  for (const t of templates) {
    const id = t.origin === 'builtin' ? t.id.slice('builtin:'.length) : t.id
    io.stdout(`${id.padEnd(28)} ${t.name}\n${' '.repeat(29)}${t.description}\n`)
  }
  for (const i of issues) io.stderr(`aviso: ${i.file}: ${i.message}\n`)
  return 0
}

/** vvpost connect: o servidor MCP em cada cliente de IA e a regra do VVPost no repositório de código. */
async function connectCommand(dir: string, io: Io, values: Values, repoArg: string | undefined): Promise<number> {
  const [{ AGENT_CLIENTS, connectRepo, detectClients }, docs] = await Promise.all([import('../mcp/connect'), import('@vvpost/core/docs')])
  const target = resolve(io.cwd, repoArg ?? '.')
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    io.stderr(`vvpost: repositório não encontrado: ${target}\n`)
    return 2
  }
  const repo = await docs.codeRepoRoot(target)
  const known = AGENT_CLIENTS.map((c) => c.id)
  const asked = splitList(values.client)
  const unknown = asked.filter((c) => !known.includes(c as never))
  if (unknown.length) {
    io.stderr(`vvpost: cliente desconhecido: ${unknown.join(', ')} (use ${known.join(', ')})\n`)
    return 2
  }
  const layout = projectLayout(dir)
  if (repo === layout.root) {
    io.stderr('vvpost: o repositório e o workspace são a mesma pasta; rode na pasta do workspace (ou com --workspace) e passe o repositório de código\n')
    return 2
  }
  const project = layout.current?.id
  const clients = asked.length ? (asked as typeof known) : await detectClients(repo)
  let endpoint: import('../mcp/connect').McpEndpoint
  if (values.http !== undefined) {
    endpoint = { transport: 'http', url: values.http.replace(/\/+(mcp)?\/?$/, ''), ...(io.env['VVPOST_MCP_TOKEN'] && { token: true }) }
  } else {
    if (!io.self?.[1]) {
      io.stderr('vvpost: não achei o servidor MCP ao lado do CLI; use --http com o servidor do app\n')
      return 2
    }
    const server = join(dirname(io.self[1]), 'mcp.js')
    // Fora do Node (o CLI dentro do app), o Electron roda o servidor como Node.
    const electron = !/^node(\.exe)?$/i.test(basename(io.self[0]!))
    endpoint = {
      transport: 'stdio',
      command: io.self[0]!,
      args: [server, '--workspace', layout.root, ...(project ? ['--project', project] : []), '--repo', repo],
      ...(electron && { env: { ELECTRON_RUN_AS_NODE: '1' } })
    }
  }
  try {
    const steps = await connectRepo({ repo, workspace: layout.root, ...(project && { project }), clients, endpoint, dryRun: !!values['dry-run'] })
    const dry = !!values['dry-run']
    const verb = { created: dry ? 'criaria' : 'criado', updated: dry ? 'atualizaria' : 'atualizado', unchanged: 'já estava', manual: 'faça à mão' }
    for (const step of steps) {
      const who = step.client === 'rule' ? 'regra' : AGENT_CLIENTS.find((c) => c.id === step.client)!.label
      io.stdout(`${who}: ${verb[step.action]}: ${step.action === 'manual' ? step.command : step.target}\n`)
    }
    if (!dry) io.stdout(`Pronto: ${repo} está ligado ao VVPost${project ? ` (projeto ${project})` : ''}. Reinicie a sessão do agente para ele ver o servidor e a regra.\n`)
    return steps.some((s) => s.action === 'manual') ? 1 : 0
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\n`)
    return 2
  }
}

/** vvpost docs agents: o trecho de CLAUDE.md / AGENTS.md; com --out, acrescenta ao arquivo se ainda não estiver lá. */
async function docsAgentsCommand(io: Io, values: Values): Promise<number> {
  const docs = await import('@vvpost/core/docs')
  const snippet = docs.docsAgentSnippet()
  if (!values.out || values.out === '-') {
    io.stdout(snippet)
    return 0
  }
  const target = resolve(io.cwd, values.out)
  try {
    const { action } = await docs.installAgentSnippet(target)
    io.stdout(
      action === 'unchanged'
        ? `${target} já tem o trecho de documentação do VVPost\n`
        : `Trecho de documentação do VVPost ${action === 'appended' ? 'acrescentado a' : 'gravado em'} ${target}\n`
    )
    return 0
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\n`)
    return 2
  }
}

/** vvpost docs init: o modelo e o documento de partida, os mesmos do editor do app. */
async function docsInitCommand(dir: string, io: Io, values: Values): Promise<number> {
  try {
    const [{ loadWorkspace }, docs] = await Promise.all([import('@vvpost/core/connectors/workspace'), import('@vvpost/core/docs')])
    const project = await docs.loadDocsProject(dir)
    if (project.configExists || project.source !== null) {
      io.stderr(`vvpost: o projeto já tem documento (${project.configExists ? docs.DOCS_CONFIG_FILE : project.sourceFile}); edite os arquivos ou use o editor do app\n`)
      return 2
    }
    const { templates } = await docs.listDocTemplates(dir)
    const wanted = values.template ?? 'api-guide'
    const template = templates.find((t) => t.id === wanted || t.id === `builtin:${wanted}` || t.id === `project:${wanted}`)
    if (!template) {
      io.stderr(`vvpost: modelo "${wanted}" não existe; veja vvpost docs templates\n`)
      return 2
    }
    const draft = docs.applyDocTemplate(template, { title: values.title ?? `Documentação de ${basename(dir)}` })
    const { files } = await docs.writeDocsProject(await loadWorkspace(dir), draft)
    io.stdout(`Criados ${files.join(' e ')} com o modelo ${template.name}. Gere com: vvpost docs\n`)
    return 0
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\n`)
    return 2
  }
}

const CONFLICT_MODES: readonly ImportConflictMode[] = ['merge', 'rename', 'replace']
const SYNC_TEXT = { updated: 'mudou na spec', conflict: 'conflito', removed: 'saiu da spec' }

/** Lê os arquivos (ou URLs) do import; um que não dá para ler vira erro dele, sem parar os outros. */
async function readSources(files: string[], cwd: string): Promise<[ImportSource[], { file: string; message: string }[]]> {
  const sources: ImportSource[] = []
  const errors: { file: string; message: string }[] = []
  for (const f of files) {
    const location = isUrl(f) ? f : resolve(cwd, f)
    try {
      const data = isUrl(f) ? await fetchImportUrl(f) : await readImportFile(location)
      sources.push({ file: isUrl(f) ? new URL(f).pathname.split('/').pop() || f : basename(f), data, location })
    } catch (err) {
      errors.push({ file: f, message: (err as Error).message })
    }
  }
  return [sources, errors]
}

async function importCommand(dir: string, io: Io, values: Values, files: string[]): Promise<number> {
  if (!files.length && !values.reimport) {
    io.stderr('vvpost: diga o que importar: vvpost import <arquivo.vvpost.bundle.json | coleção do Postman | spec OpenAPI | Insomnia | pasta ou .bru do Bruno | .har | .wsdl | URL>...\n')
    return 2
  }
  if (files.length && values.reimport) {
    io.stderr('vvpost: --reimport já diz de onde ler a spec; não passe arquivos junto\n')
    return 2
  }
  const mode = (values.conflict ?? 'merge') as ImportConflictMode
  if (!CONFLICT_MODES.includes(mode)) {
    io.stderr(`vvpost: --conflict ${values.conflict}: use merge, rename ou replace\n`)
    return 2
  }
  const prepared = values.reimport
    ? await prepareSpecReimport(dir, values.reimport)
    : await prepareSources(...(await readSources(files, io.cwd)))
  const target = { dir, isWorkspace: true }
  // O mesmo modo para todo id que já existe no projeto.
  const first = await previewImport(prepared, target)
  const all = (list: { key: string; conflict?: ImportConflictMode }[]) =>
    Object.fromEntries(list.filter((x) => x.conflict).map((x) => [x.key, mode]))
  // Reimportação de spec: o padrão do app, com --spec-wins para conflitos e --prune para o que saiu da spec.
  const syncDecisions = Object.fromEntries(
    first.connectors
      .flatMap((c) => c.endpoints)
      .filter((e) => (e.status === 'conflict' && values['spec-wins']) || (e.status === 'removed' && values.prune))
      .map((e) => [e.sync!.key, 'spec' as const])
  )
  const input = {
    conflicts: all(first.connectors.filter((c) => c.origin === 'imported' || c.conflict)),
    environmentConflicts: all(first.environments),
    flowConflicts: all(first.flows),
    syncDecisions
  }
  const preview = await previewImport(prepared, target, input)
  const sync = preview.connectors.flatMap((c) =>
    c.endpoints
      .filter((e) => e.sync)
      .map((e) => ({ endpoint: e.sync!.key, status: e.status, decision: e.sync!.decision, changes: e.sync!.changes.map((ch) => ch.field) }))
  )
  const asJson = values.json === '-'
  const out = {
    sources: preview.sources.map((s) => ({ file: s.file, kind: s.kind })),
    changes: preview.changes,
    secretValues: preview.secretValues,
    ...(sync.length && { sync }),
    warnings: [...preview.warnings, ...preview.notes],
    errors: preview.errors
  }
  if (preview.errors.length) {
    if (asJson) io.stdout(`${JSON.stringify({ ok: false, ...out }, null, 2)}\n`)
    for (const e of preview.errors) io.stderr(`${e.file}: ${e.message}\n`)
    io.stderr('vvpost: nada foi gravado\n')
    return 2
  }
  if (!values['dry-run'] && preview.changes.length) await writeImport(prepared, target, input)
  if (asJson) {
    io.stdout(`${JSON.stringify({ ok: true, dryRun: !!values['dry-run'], ...out }, null, 2)}\n`)
    return 0
  }
  for (const w of out.warnings) io.stderr(`aviso: ${w.source}: ${w.message}\n`)
  const lines = preview.changes.map((c) => `  ${c.action === 'create' ? 'novo' : c.action === 'update' ? 'alterado' : 'apagado'}  ${c.path}`)
  io.stdout(
    [
      preview.changes.length
        ? `${values['dry-run'] ? 'Mudaria' : 'Importado'} em ${dir}: ${preview.changes.length} arquivo(s)`
        : `Nada para importar em ${dir}: tudo já está no projeto`,
      ...lines,
      ...sync.map((x) => `  ${SYNC_TEXT[x.status as keyof typeof SYNC_TEXT]}${x.decision === 'spec' ? '' : ' (mantido)'}  ${x.endpoint}${x.changes.length ? `: ${x.changes.join(', ')}` : ''}`),
      ...(preview.secretValues && !values['dry-run']
        ? [`${preview.secretValues} valor(es) de segredo no cofre local (cifrado, fora da pasta)`]
        : [])
    ].join('\n') + '\n'
  )
  return 0
}

/**
 * Cliente HTTP do CLI (spec, fase 12): proxy das variáveis de ambiente (como o curl) ou de
 * --proxy, --insecure, --ca e um cookie jar que vale para a execução inteira, gravado em
 * --cookie-jar se pedido.
 */
async function cliClientConfig(values: Values, io: Io): Promise<{ client: HttpClientConfig; saveCookies: () => Promise<void> }> {
  const proxyArg = values.proxy?.trim()
  const proxy: HttpClientConfig['proxy'] =
    proxyArg === 'off' ? { mode: 'off' } : proxyArg ? { mode: 'manual', url: proxyArg, bypass: io.env['NO_PROXY'] ?? io.env['no_proxy'] ?? '' } : { mode: 'env', env: io.env }
  const ca: string[] = []
  for (const file of values.ca ?? []) {
    const pem = await readFile(resolve(io.cwd, file), 'utf8').catch(() => null)
    if (pem === null || !pem.includes('-----BEGIN CERTIFICATE-----')) throw new Error(`--ca ${file}: não é um certificado PEM legível`)
    ca.push(pem)
  }
  const jarFile = values['cookie-jar'] === undefined ? undefined : resolve(io.cwd, values['cookie-jar'])
  let stored: StoredCookie[] = []
  if (jarFile) {
    const raw = await readFile(jarFile, 'utf8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? '[]' : Promise.reject(err)))
    try {
      stored = JSON.parse(raw) as StoredCookie[]
    } catch {
      throw new Error(`--cookie-jar ${values['cookie-jar']}: não é JSON`)
    }
    if (!Array.isArray(stored)) throw new Error(`--cookie-jar ${values['cookie-jar']}: esperava uma lista de cookies`)
  }
  const cookies = new CookieJar(stored)
  return {
    client: { proxy, ...(values.insecure && { verifyTls: false }), ...(ca.length && { ca }), cookies },
    saveCookies: async () => {
      if (jarFile) await writeFile(jarFile, JSON.stringify(cookies.toJSON(), null, 2), { mode: 0o600 })
    }
  }
}

/** Mostra a URL do login e tenta abrir no navegador padrão; se não abrir, a pessoa copia do terminal. */
function openInBrowser(url: string, io: Io): void {
  io.stderr(`vvpost: faça o login no navegador para continuar:\n  ${url}\n`)
  const [cmd, args] =
    // rundll32 no Windows: o cmd /c start interpretaria os & da query.
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  try {
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref()
  } catch {
    // sem navegador (servidor, SSH): a URL já está no terminal
  }
}
