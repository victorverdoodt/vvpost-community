import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  REQUIRED_SECRET,
  validateConnector,
  validateEnvironment,
  validateFlow,
  type Connector,
  type Environment,
  type Flow
} from '@vvpost/schemas'
import { compileFlows } from '../flows/inherit'
import { literalFlowSecrets, loadFlows } from '../flows/workspace'
import { PROJECT_FILE, projectLayout, splitProjectRef, type WorkspaceProject } from '../projects'
import { SECRETS_FILE } from '../secrets'
import { readVault, VAULT_LABEL, VaultError } from '../vault'
import { ConfigError } from './errors'
import { literalSecrets } from './literal-secrets'
import { sharedConnectorsProvider, type SharedConnector } from './shared'
import { resolveConnectorSchemas, SCHEMA_NAME, SCHEMA_SUFFIX, SCHEMAS_DIR, schemaFile, type SharedSchema } from './shared-schemas'

const CONNECTOR_SUFFIX = '.connector.vvpost.json'
const ENV_SUFFIX = '.env.json'
/** Pastas que nunca têm conectores e podem ser enormes. */
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'build'])
const MAX_DEPTH = 6

export interface WorkspaceIssue {
  /** Caminho relativo ao workspace, com "/". */
  file: string
  message: string
}

export interface LoadWorkspaceOptions {
  /** Conectores compartilhados desta leitura; sem isso, vale o provider registrado. */
  shared?: SharedConnector[]
  /** Projetos já em carga nesta leitura (referências entre projetos), para não entrar em ciclo. */
  visiting?: ReadonlySet<string>
}

export interface LoadedWorkspace {
  dir: string
  connectors: Map<string, Connector>
  /** Arquivo de cada conector, para mensagens de erro ("shared:<origem>" para os compartilhados). */
  connectorFiles: Map<string, string>
  /** Conectores compartilhados (somente leitura): id → origem. */
  shared?: Map<string, string>
  /**
   * O que veio de fluxos com herança (docs/flows.md, Herança entre fluxos): id do conector de
   * um fluxo-base, ou "<conector>/<endpoint>" de um fluxo de requisição → arquivo do fluxo.
   * Quem grava conectores deixa esses de fora: o arquivo deles é o do fluxo.
   */
  flowSources?: Map<string, string>
  environments: Map<string, Environment>
  /** Arquivo de cada ambiente lido desta pasta (os do Compartilhado de um projeto ficam de fora). */
  environmentFiles?: Map<string, string>
  /**
   * Schemas compartilhados (schemas/<Nome>.schema.json), pelo nome; num projeto, também os do
   * Compartilhado da raiz, só para leitura. Os conectores de `connectors` já vêm com as citações
   * "schema:<Nome>" resolvidas.
   */
  schemas?: Map<string, SharedSchema>
  /** Os usos de cada schema compartilhado: "<conector>/<endpoint>" (ou "...#<exemplo>"). */
  schemaUses?: Map<string, string[]>
  /**
   * Os conectores que citam schemas compartilhados, como eram antes da resolução: quem grava (o
   * editor de um fluxo-base, o import) parte deles, para não copiar o schema em cada endpoint.
   */
  unresolved?: Map<string, Connector>
  /** Pasta do workspace: igual a `dir`, ou a pasta acima quando `dir` é um projeto. */
  root?: string
  /** O projeto de `dir`, quando o workspace tem projetos e `dir` é um deles. */
  project?: WorkspaceProject
  /** Os projetos do workspace (vazio: o workspace é um projeto só). */
  projects?: WorkspaceProject[]
  /** Valores locais dos segredos: id do ambiente → variável → valor. Só no main process. */
  secrets: Record<string, Record<string, string>>
  issues: WorkspaceIssue[]
}

/**
 * Lê o workspace do disco: todo *.connector.vvpost.json (em qualquer subpasta que
 * não comece com "." nem seja um projeto), environments/*.env.json e os segredos do cofre local
 * (o .vvpost/secrets.local.json antigo migra na leitura).
 * Arquivo inválido vira issue e fica de fora; o resto do workspace continua usável.
 *
 * `dir` pode ser a pasta de um projeto (docs/git-workspace.md, Projetos): aí entram também, só
 * para leitura, o Compartilhado da raiz (conectores, fluxos-base, ambientes e segredos, que o
 * projeto complementa) e as bases de outros projetos citadas como "<projeto>:<id>".
 */
export async function loadWorkspace(dir: string, options: LoadWorkspaceOptions = {}): Promise<LoadedWorkspace> {
  const ws: LoadedWorkspace = {
    dir,
    connectors: new Map(),
    connectorFiles: new Map(),
    shared: new Map(),
    flowSources: new Map(),
    environments: new Map(),
    environmentFiles: new Map(),
    secrets: {},
    issues: []
  }
  const rel = (path: string) => relative(dir, path).split(sep).join('/')
  const layout = projectLayout(dir)
  ws.root = layout.root
  ws.projects = layout.projects
  if (layout.current) ws.project = layout.current
  // Os manifestos com erro aparecem uma vez, na leitura da raiz.
  if (!layout.current) ws.issues.push(...layout.issues)

  // O Compartilhado de um projeto é a leitura da raiz, que já traz os conectores da organização.
  let base: LoadedWorkspace | undefined
  if (layout.current) {
    base = await loadWorkspace(layout.root, { ...options, visiting: new Set([...(options.visiting ?? []), layout.current.id]) })
    const up = (file: string) => (file.startsWith('shared:') ? file : `../${file}`)
    for (const [id, connector] of base.connectors) {
      ws.connectors.set(id, connector)
      ws.connectorFiles.set(id, up(base.connectorFiles.get(id)!))
      ws.shared!.set(id, base.shared?.get(id) ?? 'Compartilhado do workspace')
    }
    for (const issue of base.issues) ws.issues.push({ ...issue, file: up(issue.file) })
  }
  ws.schemas = new Map()
  for (const [name, s] of base?.schemas ?? []) ws.schemas.set(name, { ...s, file: `../${s.file}`, shared: s.shared ?? 'Compartilhado do workspace' })
  // Os do projeto vencem os do Compartilhado com o mesmo nome, como nos ambientes.
  for (const s of await loadSchemas(dir, ws, rel)) ws.schemas.set(s.name, s)

  // Compartilhados primeiro: o mesmo id num arquivo local fica de fora, para que um
  // workspace não troque em silêncio o conector que a organização publicou.
  let shared = base ? [] : options.shared
  const provider = sharedConnectorsProvider()
  if (!shared && provider) {
    shared = await provider(dir).catch((err: Error) => {
      ws.issues.push({ file: 'shared', message: `conectores compartilhados indisponíveis: ${err.message}` })
      return []
    })
  }
  // Fluxos publicados no catálogo (uma base, ou uma requisição que herda de uma base de lá)
  // entram como os do workspace: a base vira conector e a requisição, endpoint dela.
  const sharedFlows: { file: string; flow: Flow }[] = []
  const sources = new Map<string, string>()
  for (const { source, doc } of shared ?? []) {
    const label = `shared:${source}`
    if (doc && typeof doc === 'object' && Array.isArray((doc as { nodes?: unknown }).nodes)) {
      const flow = validateFlow(doc)
      if (!flow.ok) {
        for (const i of flow.issues) ws.issues.push({ file: label, message: `${i.path || '/'}: ${i.message}` })
        continue
      }
      const literals = literalFlowSecrets(flow.value)
      if (literals.length) {
        ws.issues.push({ file: label, message: `"${flow.value.id}" tem credencial literal (${literals.join(', ')}); ignorado` })
        continue
      }
      sharedFlows.push({ file: label, flow: flow.value })
      sources.set(label, source)
      continue
    }
    const result = validateConnector(doc)
    if (!result.ok) {
      for (const i of result.issues) ws.issues.push({ file: label, message: `${i.path || '/'}: ${i.message}` })
      continue
    }
    const literals = literalSecrets(result.value)
    if (literals.length) {
      ws.issues.push({ file: label, message: `"${result.value.id}" tem credencial literal (${literals.join(', ')}); ignorado` })
      continue
    }
    const first = ws.connectorFiles.get(result.value.id)
    if (first) {
      ws.issues.push({ file: label, message: `id "${result.value.id}" já usado em ${first}; ignorado` })
      continue
    }
    ws.connectors.set(result.value.id, result.value)
    ws.connectorFiles.set(result.value.id, label)
    ws.shared!.set(result.value.id, source)
  }
  if (sharedFlows.length) {
    const compiled = compileFlows(sharedFlows, ws.connectors)
    ws.issues.push(...compiled.issues)
    for (const { connector, file } of compiled.bases) {
      ws.connectors.set(connector.id, connector)
      ws.connectorFiles.set(connector.id, file)
      ws.shared!.set(connector.id, sources.get(file)!)
    }
    for (const { connectorId, endpoint } of compiled.endpoints) {
      const parent = ws.connectors.get(connectorId)!
      ws.connectors.set(connectorId, { ...parent, endpoints: [...(parent.endpoints ?? []), endpoint] })
    }
  }

  for (const path of await findFiles(dir, CONNECTOR_SUFFIX)) {
    const doc = await readJson(path, ws, rel(path))
    if (doc === undefined) continue
    const result = validateConnector(doc)
    if (!result.ok) {
      for (const i of result.issues) ws.issues.push({ file: rel(path), message: `${i.path || '/'}: ${i.message}` })
      continue
    }
    const first = ws.connectorFiles.get(result.value.id)
    if (first) {
      const sharedFrom = ws.shared!.get(result.value.id)
      ws.issues.push({
        file: rel(path),
        message: sharedFrom
          ? `id "${result.value.id}" é do conector compartilhado de ${sharedFrom}; arquivo ignorado (use outro id com "extends": "${result.value.id}")`
          : `id "${result.value.id}" já usado em ${first}; ignorado`
      })
      continue
    }
    ws.connectors.set(result.value.id, result.value)
    ws.connectorFiles.set(result.value.id, rel(path))
  }

  const flows = (await loadFlows(dir)).flows
  await addProjectRefs(ws, layout.projects, flows, options)

  // Fluxos-base viram conectores e fluxos de requisição, endpoints do pai. Os erros de
  // JSON e de schema dos fluxos já aparecem na lista de fluxos; aqui só os da herança.
  const compiled = compileFlows(flows, ws.connectors)
  ws.issues.push(...compiled.issues)
  for (const { connector, file } of compiled.bases) {
    ws.connectors.set(connector.id, connector)
    ws.connectorFiles.set(connector.id, file)
    ws.flowSources!.set(connector.id, file)
  }
  for (const { connectorId, endpoint, file } of compiled.endpoints) {
    const parent = ws.connectors.get(connectorId)!
    // Cópia: o conector lido do arquivo continua como está no disco.
    ws.connectors.set(connectorId, { ...parent, endpoints: [...(parent.endpoints ?? []), endpoint] })
    ws.flowSources!.set(`${connectorId}/${endpoint.id}`, file)
  }
  resolveSchemas(ws)

  const envDir = join(dir, 'environments')
  for (const name of (await listDir(envDir)).filter((n) => n.endsWith(ENV_SUFFIX)).sort()) {
    const path = join(envDir, name)
    const doc = await readJson(path, ws, rel(path))
    if (doc === undefined) continue
    const result = validateEnvironment(doc)
    if (!result.ok) {
      for (const i of result.issues) ws.issues.push({ file: rel(path), message: `${i.path || '/'}: ${i.message}` })
    } else if (ws.environments.has(result.value.id)) {
      ws.issues.push({ file: rel(path), message: `ambiente "${result.value.id}" duplicado; ignorado` })
    } else {
      ws.environments.set(result.value.id, result.value)
      ws.environmentFiles!.set(result.value.id, rel(path))
    }
  }
  if (base) {
    // O ambiente do projeto complementa o do Compartilhado com o mesmo id: as variáveis do projeto vencem.
    for (const [id, env] of base.environments) {
      const own = ws.environments.get(id)
      ws.environments.set(id, own ? { ...env, ...own, variables: { ...env.variables, ...own.variables } } : env)
    }
    for (const [envId, vars] of Object.entries(base.secrets)) ws.secrets[envId] = { ...vars }
  }

  // O cofre local (vault.ts), fora da pasta; o .vvpost/secrets.local.json antigo migra na leitura.
  try {
    for (const [envId, vars] of Object.entries(await readVault(dir))) ws.secrets[envId] = { ...ws.secrets[envId], ...vars }
  } catch (err) {
    ws.issues.push({ file: err instanceof VaultError && /secrets\.local\.json/.test(err.message) ? SECRETS_FILE : VAULT_LABEL, message: (err as Error).message })
  }
  return ws
}

/** schemas/*.schema.json de `dir`: arquivo inválido vira issue e fica de fora. */
async function loadSchemas(dir: string, ws: LoadedWorkspace, rel: (path: string) => string): Promise<SharedSchema[]> {
  const out: SharedSchema[] = []
  const folder = join(dir, SCHEMAS_DIR)
  for (const name of (await listDir(folder)).filter((n) => n.endsWith(SCHEMA_SUFFIX)).sort()) {
    const path = join(folder, name)
    const schemaName = name.slice(0, -SCHEMA_SUFFIX.length)
    if (!SCHEMA_NAME.test(schemaName)) {
      ws.issues.push({ file: rel(path), message: `nome de schema inválido: "${schemaName}" (letras, números, _, . e -, começando por letra ou _)` })
      continue
    }
    const doc = await readJson(path, ws, rel(path))
    if (doc === undefined) continue
    if (!isRecord(doc)) {
      ws.issues.push({ file: rel(path), message: 'o schema precisa ser um objeto JSON Schema' })
      continue
    }
    out.push({ name: schemaName, file: schemaFile(schemaName), schema: doc })
  }
  return out
}

/**
 * Troca as citações "schema:<Nome>" dos endpoints pelos schemas (shared-schemas.ts). Os conectores
 * que vieram prontos (do Compartilhado, de outro projeto) já chegam resolvidos e não mudam aqui.
 */
function resolveSchemas(ws: LoadedWorkspace): void {
  const schemas = ws.schemas ?? new Map<string, SharedSchema>()
  const uses = new Map<string, string[]>()
  for (const [id, connector] of ws.connectors) {
    const resolved = resolveConnectorSchemas(
      connector,
      (name) => schemas.get(name)?.schema,
      (name, where) =>
        ws.issues.push({
          file: ws.flowSources?.get(where.split('#')[0]!) ?? ws.connectorFiles.get(id) ?? id,
          message: `${where}: o schema "${name}" não existe (crie ${schemaFile(name)})`
        }),
      (name, where) => uses.set(name, [...(uses.get(name) ?? []), where])
    )
    if (!resolved) continue
    ;(ws.unresolved ??= new Map()).set(id, connector)
    ws.connectors.set(id, resolved)
  }
  if (uses.size) ws.schemaUses = uses
}

/**
 * Valores das variáveis de um ambiente, com os segredos lidos do arquivo local.
 * Um segredo sem valor local não entra no mapa: só falha se alguém usar.
 */
export function environmentValues(ws: LoadedWorkspace, envId: string | undefined): {
  values: Map<string, string>
  missingSecrets: Set<string>
} {
  const values = new Map<string, string>()
  const missingSecrets = new Set<string>()
  if (!envId) return { values, missingSecrets }
  const env = ws.environments.get(envId)
  if (!env) throw new ConfigError(`ambiente "${envId}" não existe no workspace`)
  const local = ws.secrets[envId] ?? {}
  for (const [name, variable] of Object.entries(env.variables)) {
    if (variable.isSecret || variable.value === REQUIRED_SECRET) {
      const value = local[name]
      if (value === undefined || value === REQUIRED_SECRET) {
        missingSecrets.add(name)
        continue
      }
      values.set(name, value)
    } else {
      values.set(name, String(variable.value))
    }
  }
  return { values, missingSecrets }
}

export async function findFiles(dir: string, suffix: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (depth === 0) throw err
    return []
  }
  const found: string[] = []
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      // Uma subpasta com vvpost.project.json é outro projeto: os arquivos dela não são desta pasta.
      if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && !(await isFile(join(dir, e.name, PROJECT_FILE)))) {
        found.push(...(await findFiles(join(dir, e.name), suffix, depth + 1)))
      }
    } else if (e.isFile() && e.name.endsWith(suffix)) {
      found.push(join(dir, e.name))
    }
  }
  return found
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function readJson(
  path: string,
  ws: LoadedWorkspace,
  file: string,
  { optional = false } = {}
): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (!(optional && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      ws.issues.push({ file, message: (err as Error).message })
    }
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    ws.issues.push({ file, message: `JSON inválido (${(err as Error).message})` })
    return undefined
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Os avisos de referência circular, para quem começou o ciclo repetir o motivo. */
const cycles = new WeakSet<WorkspaceIssue>()

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isFile(), () => false)
}

/**
 * As bases de outros projetos citadas como "<projeto>:<id>" (extends de conectores e fluxos,
 * connector de nós): entram com o id qualificado, só para leitura, com a cadeia delas dentro
 * do projeto de origem. O Compartilhado já está no mapa, com os mesmos ids.
 */
async function addProjectRefs(
  ws: LoadedWorkspace,
  projects: WorkspaceProject[],
  flows: { file: string; flow: Flow }[],
  options: LoadWorkspaceOptions
): Promise<void> {
  const refs = new Map<string, string>()
  for (const [id, connector] of ws.connectors) if (!ws.shared?.has(id)) noteRef(ws, refs, connector.extends, ws.connectorFiles.get(id)!)
  for (const { file, flow } of flows) noteFlowRefs(ws, refs, flow, file)
  await addRefs(ws, projects, refs, options)
}

function noteRef(ws: LoadedWorkspace, refs: Map<string, string>, ref: string | undefined, file: string): void {
  if (ref && splitProjectRef(ref) && !ws.connectors.has(ref) && !refs.has(ref)) refs.set(ref, file)
}

function noteFlowRefs(ws: LoadedWorkspace, refs: Map<string, string>, flow: Flow, file: string): void {
  noteRef(ws, refs, flow.extends, file)
  for (const n of flow.nodes) {
    if (n.type === 'request') noteRef(ws, refs, n.request.connector, file)
    else if (n.type === 'plugin') noteRef(ws, refs, n.plugin.connector, file)
  }
}

/**
 * Um fluxo ainda não gravado (o do canvas) pode citar uma base de outro projeto que nenhum arquivo
 * cita: ela entra no workspace já carregado, como entraria na leitura do disco.
 */
export async function addFlowProjectRefs(ws: LoadedWorkspace, flow: Flow, file = `fluxo ${flow.id}`): Promise<void> {
  if (!ws.projects?.length) return
  const refs = new Map<string, string>()
  noteFlowRefs(ws, refs, flow, file)
  await addRefs(ws, ws.projects, refs, {})
}

/**
 * As bases dos outros projetos que este pode citar como "<projeto>:<id>" num nó ou num extends,
 * para o app oferecer na escolha do conector. Devolve uma cópia de `ws` com elas (e a cadeia de
 * cada uma) e os ids novos; `ws` não muda, e as que ele já cita ficam de fora (já estão nele).
 */
export async function otherProjectBases(ws: LoadedWorkspace): Promise<{ ws: LoadedWorkspace; ids: string[] }> {
  const extra: LoadedWorkspace = {
    ...ws,
    connectors: new Map(ws.connectors),
    connectorFiles: new Map(ws.connectorFiles),
    shared: new Map(ws.shared),
    issues: []
  }
  if (!ws.project || !ws.projects?.length) return { ws: extra, ids: [] }
  const refs = new Map<string, string>()
  const visiting = new Set([ws.project.id])
  for (const project of ws.projects) {
    if (project.id === ws.project.id) continue
    const other = await loadWorkspace(join(ws.root ?? ws.dir, project.folder), { visiting }).catch(() => null)
    for (const id of other?.connectors.keys() ?? []) {
      if (!other!.shared?.has(id) && !splitProjectRef(id)) noteRef(ws, refs, `${project.id}:${id}`, PROJECT_FILE)
    }
  }
  await addRefs(extra, ws.projects, refs, {})
  return { ws: extra, ids: [...extra.connectors.keys()].filter((id) => !ws.connectors.has(id)) }
}

async function addRefs(
  ws: LoadedWorkspace,
  projects: WorkspaceProject[],
  refs: Map<string, string>,
  options: LoadWorkspaceOptions
): Promise<void> {
  if (!refs.size) return
  const loaded = new Map<string, LoadedWorkspace | null>()
  for (const [ref, file] of refs) {
    const [projectId, id] = splitProjectRef(ref)!
    const project = projects.find((p) => p.id === projectId)
    if (!project) {
      ws.issues.push({ file, message: `"${ref}": o projeto "${projectId}" não existe no workspace (${projects.map((p) => p.id).join(', ') || 'sem projetos'})` })
      continue
    }
    if (project.id === ws.project?.id) {
      ws.issues.push({ file, message: `"${ref}" é deste projeto: use só "${id}"` })
      continue
    }
    if (options.visiting?.has(project.id)) {
      const issue = { file, message: `"${ref}": referência circular entre projetos (${[...options.visiting, project.id].join(' → ')})` }
      ws.issues.push(issue)
      cycles.add(issue)
      continue
    }
    if (!loaded.has(project.id)) {
      const visiting = new Set([...(options.visiting ?? []), ...(ws.project ? [ws.project.id] : [])])
      loaded.set(project.id, await loadWorkspace(join(ws.root ?? ws.dir, project.folder), { ...options, visiting }).catch(() => null))
    }
    const other = loaded.get(project.id)
    // Um ciclo é achado dentro do outro projeto; aparece também aqui, onde ele começa.
    const cycle = other?.issues.find((i) => cycles.has(i))
    if (cycle || !other?.connectors.has(id)) {
      const issue = { file, message: cycle?.message ?? `"${ref}": o projeto "${projectId}" não tem a base "${id}"` }
      ws.issues.push(issue)
      if (cycle) cycles.add(issue)
      continue
    }
    // A cadeia dentro do outro projeto: os ids dele ganham o prefixo, os do Compartilhado ficam.
    const own = (cid: string) => !other.shared?.has(cid) && !splitProjectRef(cid)
    const qualify = (cid: string) => (own(cid) ? `${project.id}:${cid}` : cid)
    for (let cid: string | undefined = id, depth = 0; cid && depth < 16; depth++) {
      const connector = other.connectors.get(cid)
      if (!connector) break
      const key = qualify(cid)
      if (ws.connectors.has(key)) break
      if (!own(cid) && !splitProjectRef(cid)) break
      ws.connectors.set(key, { ...connector, id: key, ...(connector.extends && { extends: qualify(connector.extends) }) })
      ws.connectorFiles.set(key, `project:${project.id}/${other.connectorFiles.get(cid)}`)
      ws.shared!.set(key, `projeto ${project.name}`)
      cid = connector.extends
    }
  }
}
