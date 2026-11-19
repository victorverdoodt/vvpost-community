import { readFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { findFiles, loadWorkspace } from '@vvpost/core/connectors/workspace'
import { projectLayout, splitProjectRef } from '@vvpost/core/projects'
import { isBaseFlow } from '@vvpost/core/flows/inherit'
import type { Flow } from '@vvpost/schemas'
import type { RemoteRun, RemoteRunPoll, RemoteRunPreview, RemoteRunSelection, RemoteRunTarget } from '@shared/ipc'
import { controlPlane, sharedConnectors } from './control-plane'

/** Os mesmos limites do Control Plane (RunService), conferidos antes de enviar. */
const MAX_FILES = 2000
const MAX_BYTES = 5 * 1024 * 1024
const REQUIRED_SECRET = '__REQUIRED_SECRET__'

const FINAL = new Set(['passed', 'failed', 'error', 'canceled', 'lost'])

export const isFinal = (status: string): boolean => FINAL.has(status)

async function runs() {
  const ext = (await controlPlane())?.runs
  if (!ext) throw new Error('Execução remota precisa do VVPost Enterprise com um Control Plane configurado.')
  return ext
}

/** Para onde as execuções iriam; null sem módulo Enterprise ou sem Control Plane. */
export async function remoteRunTarget(): Promise<RemoteRunTarget | null> {
  const ext = (await controlPlane())?.runs
  return ext ? ext.target() : null
}

/**
 * O que `startRemoteRun` enviaria, sem enviar: o mesmo pacote, resumido por nome para a pessoa
 * confirmar destino, ambiente, projeto e segredos antes.
 */
export async function previewRemoteRun(dir: string, selection: RemoteRunSelection): Promise<RemoteRunPreview> {
  const ext = await runs()
  const [target, files] = await Promise.all([ext.target(), workspaceBundle(dir)])
  if (!target) throw new Error('Execução remota precisa de um projeto no Control Plane.')
  const docs = Object.entries(files) as [string, Record<string, unknown>][]
  const environments = docs
    .filter(([path]) => path.startsWith('environments/'))
    .map(([, env]) => ({
      id: String(env['id']),
      name: String(env['name'] ?? env['id']),
      secrets: Object.entries((env['variables'] ?? {}) as Record<string, { isSecret?: unknown }>)
        .filter(([, v]) => v?.isSecret === true)
        .map(([name]) => name)
    }))
  const connectors = docs
    .filter(([path, doc]) => definesConnector(path, doc))
    .map(([, c]) => ({ id: String(c['id']), name: String(c['name'] ?? c['id']) }))
  return {
    source: target.source,
    workspace: basename(dir),
    // Sem ambiente o CLI roda sem --env: nenhum ambiente vai junto na conta.
    environments: environments.filter((e) => selection.environments.includes(e.id)),
    connectors: selection.connectors.length ? connectors.filter((c) => selection.connectors.includes(c.id)) : connectors,
    scenarios: selection.scenarios,
    files: docs.length,
    shared: docs.filter(([path]) => path.startsWith('shared/')).length,
    compartilhado: docs.filter(([path]) => path.startsWith('compartilhado/')).length,
    otherProjects: docs.filter(([path]) => path.startsWith('projetos/')).length,
    bytes: Buffer.byteLength(JSON.stringify(files))
  }
}

export async function startRemoteRun(dir: string, selection: RemoteRunSelection): Promise<RemoteRun> {
  const ext = await runs()
  return ext.start({ files: await workspaceBundle(dir), ...selection })
}

export async function pollRemoteRun(id: number, after: number): Promise<RemoteRunPoll> {
  const ext = await runs()
  const events = await ext.events(id, after)
  const { run, report } = await ext.get(id)
  return { run, events, ...(FINAL.has(run.status) && report != null && { report: report as RemoteRunPoll['report'] }) }
}

export async function cancelRemoteRun(id: number): Promise<RemoteRun> {
  return (await runs()).cancel(id)
}

/** Um arquivo de conector, ou um fluxo-base, que é o conector no formato de fluxos. */
function definesConnector(path: string, doc: unknown): boolean {
  if (path.endsWith('.connector.vvpost.json')) return true
  if (!path.endsWith('.flow.vvpost.json')) return false
  const nodes = (doc as { nodes?: unknown }).nodes
  return isBaseFlow({ ...(doc as object), nodes: Array.isArray(nodes) ? nodes : [] } as Flow)
}

/**
 * O workspace como o runner vai ver: conectores, fluxos e ambientes, sem nada de .vvpost/
 * (o vault local nunca sai da máquina) e com o valor de toda variável isSecret trocado
 * por __REQUIRED_SECRET__. Num projeto, o Compartilhado da raiz vai junto em compartilhado/,
 * com os ambientes mesclados. Os conectores e fluxos-base do catálogo da organização vão junto em
 * shared/, porque o runner não sincroniza o catálogo; um arquivo local com o mesmo id
 * fica, como no app. As bases de outro projeto que este usa ("<projeto>:<id>") vão em
 * projetos/<projeto>/, como o app as lê, com um id sem ":" e as referências trocadas.
 */
export async function workspaceBundle(dir: string): Promise<Record<string, unknown>> {
  const files: Record<string, unknown> = {}
  let bytes = 0
  const add = (path: string, doc: unknown) => {
    if (Object.keys(files).length >= MAX_FILES) throw new Error(`O workspace passa de ${MAX_FILES} arquivos para a execução remota.`)
    bytes += Buffer.byteLength(path) + Buffer.byteLength(JSON.stringify(doc))
    if (bytes > MAX_BYTES) throw new Error('O workspace passa de 5 MB para a execução remota.')
    files[path] = doc
  }
  const read = async (abs: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(abs, 'utf8'))
    } catch {
      return undefined // arquivo inválido: o loader local já avisa; o runner não precisa dele
    }
  }
  const isObject = (doc: unknown): doc is Record<string, unknown> => typeof doc === 'object' && doc !== null && !Array.isArray(doc)
  const idOf = (doc: Record<string, unknown>) => (typeof doc['id'] === 'string' ? doc['id'] : undefined)

  // Num workspace com projetos, cada projeto é uma subpasta: a leitura de uma pasta não entra nelas.
  const layout = projectLayout(dir)
  const projectFolders = new Set(layout.projects.map((p) => p.folder))
  const definitions = async (from: string) => {
    const out: { path: string; doc: Record<string, unknown> }[] = []
    for (const abs of await findFiles(from, '.vvpost.json')) {
      const path = relative(from, abs).split(sep).join('/')
      if (path.split('/').some((p) => p.startsWith('.'))) continue
      if (from === layout.root && projectFolders.has(path.split('/')[0]!)) continue
      const doc = await read(abs)
      if (isObject(doc)) out.push({ path, doc })
    }
    return out
  }
  const environments = async (from: string) => {
    const out: { path: string; doc: Record<string, unknown> }[] = []
    for (const abs of await findFiles(join(from, 'environments'), '.env.json').catch(() => [] as string[])) {
      const path = relative(from, abs).split(sep).join('/')
      if (path.split('/').length !== 2) continue
      const doc = await read(abs)
      if (isObject(doc)) out.push({ path, doc })
    }
    return out
  }

  const localIds = new Set<string>()
  const envs = new Map<string, { path: string; doc: Record<string, unknown> }>()
  if (layout.current) {
    // Um projeto roda com o Compartilhado da raiz, como no app: o runner recebe um workspace só,
    // com os conectores e fluxos da raiz em compartilhado/ e os ambientes já mesclados (as
    // variáveis do projeto vencem). Um conector do Compartilhado vence o do projeto de mesmo id.
    for (const { path, doc } of await definitions(layout.root)) {
      const id = idOf(doc)
      if (definesConnector(path, doc) && id) localIds.add(id)
      add(`compartilhado/${path}`, doc)
    }
    for (const { path, doc } of await environments(layout.root)) {
      const id = idOf(doc)
      if (id && !envs.has(id)) envs.set(id, { path, doc })
    }
  }
  for (const { path, doc } of await definitions(dir)) {
    const id = idOf(doc)
    if (definesConnector(path, doc) && id) {
      if (layout.current && localIds.has(id)) continue
      localIds.add(id)
    }
    add(path, doc)
  }
  for (const { path, doc } of await environments(dir)) {
    const id = idOf(doc)
    const base = id ? envs.get(id) : undefined
    const merged = base
      ? { ...base.doc, ...doc, variables: { ...(isObject(base.doc['variables']) ? base.doc['variables'] : {}), ...(isObject(doc['variables']) ? doc['variables'] : {}) } }
      : doc
    envs.set(id ?? path, { path, doc: merged })
  }
  const envPaths = new Set<string>()
  for (const { path, doc } of envs.values()) {
    // Dois ambientes com o mesmo nome de arquivo (um da raiz, outro do projeto): o da raiz ganha prefixo.
    const target = envPaths.has(path) ? path.replace('environments/', 'environments/compartilhado-') : path
    envPaths.add(target)
    add(target, withoutSecretValues(doc))
  }
  if (layout.current) await addOtherProjectBases(dir, files, localIds, add)
  for (const { doc } of await sharedConnectors().catch(() => [])) {
    const id = (doc as { id?: unknown })?.id
    if (typeof id !== 'string' || localIds.has(id) || !/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(id)) continue
    localIds.add(id)
    // Do catálogo também vêm fluxos-base e fluxos de requisição (com "nodes"): vão como fluxos.
    const flow = Array.isArray((doc as { nodes?: unknown }).nodes)
    add(`shared/${id}${flow ? '.flow.vvpost.json' : '.connector.vvpost.json'}`, doc)
  }
  return files
}

/**
 * Bases de outros projetos do workspace ("<projeto>:<id>" em extends ou no conector de um nó): o
 * runner recebe um workspace só, sem os outros projetos. Cada base vai como o app a lê (a cadeia
 * dentro do projeto de origem, já resolvida pelo loader), num conector com id sem ":"
 * (`<projeto>.<id>`), sem os cenários do outro projeto; as referências do pacote passam a esse id.
 */
async function addOtherProjectBases(
  dir: string,
  files: Record<string, unknown>,
  taken: Set<string>,
  add: (path: string, doc: unknown) => void
): Promise<void> {
  const ws = await loadWorkspace(dir)
  const refs = [...ws.connectors.keys()].filter((key) => splitProjectRef(key) && ws.connectorFiles.get(key)?.startsWith('project:'))
  if (!refs.length) return
  const renamed = new Map<string, string>()
  for (const key of refs) {
    const [project, id] = splitProjectRef(key)!
    let next = `${project}.${id}`
    for (let i = 2; taken.has(next); i++) next = `${project}.${id}-${i}`
    taken.add(next)
    renamed.set(key, next)
  }
  const ref = (value: unknown) => (typeof value === 'string' && renamed.get(value)) || value
  for (const doc of Object.values(files) as Record<string, unknown>[]) {
    if (typeof doc['extends'] === 'string') doc['extends'] = ref(doc['extends'])
    if (!Array.isArray(doc['nodes'])) continue
    for (const node of doc['nodes'] as Record<string, Record<string, unknown> | undefined>[]) {
      for (const target of [node['request'], node['plugin']]) if (target && typeof target['connector'] === 'string') target['connector'] = ref(target['connector'])
    }
  }
  for (const key of refs) {
    const connector = ws.connectors.get(key)!
    const id = renamed.get(key)!
    add(`projetos/${splitProjectRef(key)![0]}/${id}.connector.vvpost.json`, {
      ...connector,
      id,
      ...(connector.extends && { extends: ref(connector.extends) }),
      ...(connector.endpoints && { endpoints: connector.endpoints.map(({ scenarios: _, ...e }) => e) })
    })
  }
}

function withoutSecretValues(env: Record<string, unknown>): Record<string, unknown> {
  const vars = env['variables']
  if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) return env
  const out: Record<string, unknown> = {}
  for (const [name, v] of Object.entries(vars)) {
    const secret = typeof v === 'object' && v !== null && (v as { isSecret?: unknown }).isSecret === true
    out[name] = secret ? { ...(v as object), value: REQUIRED_SECRET } : v
  }
  return { ...env, variables: out }
}
