import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { SchemaId, validateFlow, type Connector, type Flow } from '@vvpost/schemas'
import type { FlowCatalog } from '../types'
import { findFiles } from '../connectors/workspace'
import { isSensitiveName } from '../secrets'
import { literalSecrets } from '../connectors/literal-secrets'

export const FLOW_SUFFIX = '.flow.vvpost.json'
const FLOWS_DIR = 'flows'

/** Todo *.flow.vvpost.json do workspace (mesma busca dos conectores). Arquivo inválido vira issue. */
export async function loadFlows(dir: string): Promise<FlowCatalog> {
  const catalog: FlowCatalog = { dir, flows: [], issues: [] }
  const seen = new Map<string, string>()
  for (const path of await findFiles(dir, FLOW_SUFFIX)) {
    const file = relative(dir, path).split(sep).join('/')
    let doc: unknown
    try {
      // Leitura síncrona de propósito: com uma requisição por arquivo, um projeto tem centenas
      // de fluxos, e o readFile assíncrono (um salto pelo pool de threads por arquivo) leva ~10x
      // mais que ler todos de uma vez. Mil arquivos pequenos são poucos ms de bloqueio.
      doc = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      catalog.issues.push({ file, message: err instanceof SyntaxError ? `JSON inválido (${err.message})` : (err as Error).message })
      continue
    }
    const result = validateFlow(doc)
    if (!result.ok) {
      for (const i of result.issues) catalog.issues.push({ file, message: `${i.path || '/'}: ${i.message}` })
      continue
    }
    const first = seen.get(result.value.id)
    if (first) {
      catalog.issues.push({ file, message: `id "${result.value.id}" já usado em ${first}; ignorado` })
      continue
    }
    seen.set(result.value.id, file)
    catalog.flows.push({ file, flow: result.value })
  }
  return catalog
}

/**
 * Valida e grava um fluxo. Sem `file`, cria flows/<id>.flow.vvpost.json; com `file`,
 * regrava esse arquivo, que precisa ser um *.flow.vvpost.json dentro do workspace.
 * Um id já usado por outro arquivo é recusado.
 */
export async function saveFlow(dir: string, flow: Flow, file?: string): Promise<{ file: string }> {
  const result = validateFlow(flow)
  if (!result.ok) {
    throw new Error(`fluxo inválido: ${result.issues.slice(0, 5).map((i) => `${i.path || '/'}: ${i.message}`).join('; ')}`)
  }
  const target = file ?? `${FLOWS_DIR}/${flow.id}${FLOW_SUFFIX}`
  const clean = normalize(target)
  if (isAbsolute(target) || clean.startsWith('..') || !clean.endsWith(FLOW_SUFFIX)) {
    throw new Error(`caminho de fluxo inválido: ${target}`)
  }
  const rel = clean.split(sep).join('/')
  const existing = (await loadFlows(dir)).flows.find((f) => f.flow.id === flow.id)
  if (existing && existing.file !== rel) throw new Error(`o id "${flow.id}" já é do fluxo em ${existing.file}`)
  const path = join(dir, clean)
  if (!file) {
    const taken = await readFile(path).then(() => true, () => false)
    if (taken) throw new Error(`${rel} já existe`)
  }
  // "$schema" primeiro, como nos outros arquivos do workspace (autocomplete nos editores).
  const { $schema: _, ...rest } = result.value
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ $schema: SchemaId.Flow, ...rest }, null, 2)}\n`)
  return { file: rel }
}

/**
 * Credenciais digitadas direto no fluxo (Authorization: Bearer abc...), em vez de um {{NOME}} do
 * ambiente ou de um {{ $nodes... }}: nos headers dos nós e dos cenários e, numa base, nos mesmos
 * campos de um conector (auth, nó OAuth2, mTLS, headers). O arquivo vai para o Git. Devolve onde, sem o valor.
 */
export function literalFlowSecrets(flow: Flow): string[] {
  const found: string[] = []
  const headers = (where: string, h: Record<string, unknown> | undefined) => {
    for (const [name, value] of Object.entries(h ?? {})) {
      if (typeof value === 'string' && value.trim() && !value.includes('{{') && isSensitiveName(name)) found.push(`header ${name} ${where}`)
    }
  }
  for (const node of flow.nodes) {
    if (node.type === 'request') headers(`do nó ${node.name}`, node.request.headers)
  }
  for (const s of flow.scenarios ?? []) headers(`do cenário ${s.name}`, s.overrides?.headers ?? undefined)
  const oauth2 = flow.nodes.find((n) => n.type === 'oauth2')
  const d = flow.defaults
  if (d || oauth2) {
    const auth = d?.auth ?? (oauth2?.type === 'oauth2' ? oauth2.oauth2 : undefined)
    const base = { id: flow.id, name: flow.name, version: '0.0.0', config: { ...(auth && { auth }), ...(d?.tls && { tls: d.tls }), ...(d?.headers && { headers: d.headers }) } }
    found.push(...literalSecrets(base as Connector).map((field) => `${field} da base`))
  }
  return found
}

/**
 * Os fluxos comuns do catálogo: sem os fluxos-base e os de requisição, que o workspace já tem como
 * os conectores e endpoints que eles são (`flowSources` de loadWorkspace).
 */
export function plainFlows(catalog: FlowCatalog, flowSources: ReadonlyMap<string, string> | undefined): FlowCatalog['flows'] {
  const compiled = new Set(flowSources?.values())
  return catalog.flows.filter((f) => !compiled.has(f.file))
}
