import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { validateWorkspacePlugins } from '@vvpost/schemas'
import type { LoadedWorkspace } from '../connectors/workspace'
import { projectLayout } from '../projects'
import type { FlowCatalog, PluginCatalog } from '../types'
import { compareVersions } from './registry'

/** Na raiz do workspace (onde fica o Compartilhado): os plugins que os projetos usam, com a versão. */
export const PLUGINS_FILE = 'vvpost.plugins.json'

export interface PluginRequirements {
  /** Caminho relativo à pasta aberta (o workspace ou o projeto), para as mensagens. */
  file: string
  /** id do plugin → versão aceita (1.2.0, ^1.2.0, ~1.2.0, >=1.2.0 ou *). */
  plugins: Record<string, string>
}

/** Um nó ou protocolo de plugin que o workspace usa, e onde. */
export interface UsedContribution {
  kind: 'node' | 'adapter'
  name: string
  /** Ex.: flows/checkout.flow.vvpost.json, nó Kafka. */
  where: string
}

/**
 * Lê o vvpost.plugins.json da raiz do workspace de `dir`. Sem o arquivo, null: os plugins
 * instalados valem como antes. Arquivo inválido é erro, com o caminho e o motivo.
 */
export async function readPluginRequirements(dir: string): Promise<PluginRequirements | null> {
  const root = projectLayout(dir).root
  const path = join(root, PLUGINS_FILE)
  const file = relative(dir, path).split(sep).join('/')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`${file}: ${(err as Error).message}`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new Error(`${file}: JSON inválido (${(err as Error).message})`)
  }
  const result = validateWorkspacePlugins(doc)
  if (!result.ok) throw new Error(`${file}: ${result.issues.map((i) => `${i.path || '/'}: ${i.message}`).join('; ')}`)
  return { file, plugins: result.value.plugins }
}

/** A versão instalada atende à pedida? Exata, ^ (mesma maior), ~ (mesma menor), >= ou *. */
export function satisfiesVersion(version: string, wanted: string): boolean {
  if (wanted === '*') return true
  const op = /^(\^|~|>=)/.exec(wanted)?.[1] ?? ''
  const base = wanted.slice(op.length)
  if (!op) return compareVersions(version, base) === 0
  if (compareVersions(version, base) < 0) return false
  if (op === '>=') return true
  const [major, minor] = base.split('.')
  const [vMajor, vMinor] = version.split('.')
  // ^0.y.z fica na mesma menor, como no npm: antes do 1.0, a menor quebra.
  if (op === '~' || major === '0') return vMajor === major && vMinor === minor
  return vMajor === major
}

/** Os nós e protocolos de plugin dos fluxos e dos endpoints do workspace. */
export function usedContributions(ws: LoadedWorkspace, flows: FlowCatalog): UsedContribution[] {
  const out: UsedContribution[] = []
  for (const { file, flow } of flows.flows) {
    for (const node of flow.nodes) {
      if (node.type !== 'plugin') continue
      const p = node.plugin
      if (p.node) out.push({ kind: 'node', name: p.node, where: `${file}, nó ${node.name}` })
      else if (p.adapter) out.push({ kind: 'adapter', name: p.adapter, where: `${file}, nó ${node.name}` })
    }
  }
  for (const [id, connector] of ws.connectors) {
    if (ws.shared?.has(id)) continue
    for (const e of connector.endpoints ?? []) {
      if (!e.plugin) continue
      const file = ws.flowSources?.get(`${id}/${e.id}`) ?? ws.connectorFiles.get(id) ?? id
      out.push({ kind: 'adapter', name: e.plugin.adapter, where: `${file}, endpoint ${e.id}` })
    }
  }
  return out
}

/**
 * O que impede o workspace de rodar como foi declarado: plugin pedido que falta, está desligado,
 * com erro ou em outra versão, e nó ou protocolo usado que nenhum plugin ligado fornece ou que vem
 * de um plugin fora do vvpost.plugins.json. Sem o arquivo, só o que falta. Uma linha por problema.
 */
export function pluginProblems(required: PluginRequirements | null, catalog: PluginCatalog, used: readonly UsedContribution[]): string[] {
  const problems: string[] = []
  const byId = new Map(catalog.plugins.map((p) => [p.id, p]))
  if (required) {
    for (const [id, wanted] of Object.entries(required.plugins)) {
      const plugin = byId.get(id)
      if (!plugin) problems.push(`${required.file} pede o plugin ${id} ${wanted}, que não está instalado`)
      else if (!plugin.enabled) problems.push(`${required.file} pede o plugin ${id} ${wanted}, que está desligado`)
      else if (!satisfiesVersion(plugin.version, wanted)) problems.push(`${required.file} pede o plugin ${id} ${wanted}; o instalado é o ${plugin.version} (${plugin.dir})`)
      else if (plugin.error) problems.push(`o plugin ${id}, pedido em ${required.file}, não pode rodar: ${plugin.error}`)
    }
  }
  const label = { node: 'o nó', adapter: 'o protocolo' }
  const reported = new Set<string>()
  for (const u of used) {
    const key = `${u.kind}:${u.name}`
    if (reported.has(key)) continue
    const providers = catalog.plugins.filter((p) => p.contributions.some((c) => c.kind === u.kind && c.name === u.name))
    const usable = providers.find((p) => p.enabled && !p.error)
    if (!usable) {
      reported.add(key)
      const declared = required && Object.keys(required.plugins).find((id) => providers.some((p) => p.id === id))
      // O plugin declarado que falta já tem a linha dele acima.
      if (declared) continue
      const hint = providers.length ? ` (o plugin ${providers[0]!.id} o fornece, mas está ${providers[0]!.enabled ? 'com erro' : 'desligado'})` : ''
      problems.push(`${u.where} usa ${label[u.kind]} ${u.name}, que nenhum plugin ligado fornece${hint}`)
      continue
    }
    if (required && !(usable.id in required.plugins)) {
      reported.add(key)
      problems.push(`${u.where} usa ${label[u.kind]} ${u.name}, do plugin ${usable.id}, que não está em ${required.file}; declare "${usable.id}": "^${usable.version}"`)
    }
  }
  return problems
}
