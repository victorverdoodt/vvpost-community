import {
  REQUIRED_SECRET,
  validateBundle,
  validateConnector,
  validateEnvironment,
  validateFlow,
  type Connector,
  type Environment,
  type Flow
} from '@vvpost/schemas'
import type { ForeignFormat } from './foreign'
import type { ImportDocuments } from './plan'
import type { ImportedSecret, ImportWarning } from './postman'

export interface ImportSourceResult extends ImportDocuments {
  sources: { file: string; kind: 'collection' | 'environment' | 'bundle' | 'openapi' | ForeignFormat; name: string }[]
  warnings: ImportWarning[]
  errors: { file: string; message: string }[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** O arquivo declara o schema do pacote do VVPost (qualquer versão). */
export function isBundle(data: unknown): boolean {
  return isObject(data) && typeof data['$schema'] === 'string' && /\/bundle\.json$/.test(data['$schema'])
}

/**
 * Lê um pacote do VVPost (schema bundle.json) para o mesmo formato de import do
 * Postman, para passar pela mesma revisão e pela camada de escrita. Cada documento é
 * validado com o próprio schema; um inválido fica de fora com erro. Um pacote não
 * devia ter segredo, mas se um ambiente trouxer valor real numa variável isSecret, o
 * valor vai para o vault e o arquivo fica com __REQUIRED_SECRET__, como no Postman.
 */
export function convertBundle(file: string, data: unknown): ImportSourceResult {
  const out: ImportSourceResult = {
    sources: [],
    connectors: [],
    environments: [],
    flows: [],
    docs: {},
    secrets: [],
    warnings: [],
    errors: []
  }
  const envelope = validateBundle(data)
  if (!envelope.ok) {
    out.errors.push(...envelope.issues.map((i) => ({ file, message: `${i.path || '/'}: ${i.message}` })))
    return out
  }
  const bundle = envelope.value
  const name = bundle.name?.trim() || file.replace(/\.json$/i, '')
  out.sources.push({ file, kind: 'bundle', name })

  const take = <T>(
    list: unknown[] | undefined,
    what: string,
    validate: (d: unknown) => { ok: true; value: T } | { ok: false; issues: { path: string; message: string }[] },
    push: (doc: T) => void
  ) => {
    ;(list ?? []).forEach((doc, i) => {
      const result = validate(doc)
      if (result.ok) push(result.value)
      else {
        const id = isObject(doc) && typeof doc['id'] === 'string' ? ` (${doc['id']})` : ''
        for (const issue of result.issues.slice(0, 5)) {
          out.errors.push({ file: `${file} › ${what}[${i}]${id}`, message: `${issue.path || '/'}: ${issue.message}` })
        }
      }
    })
  }
  take<Connector>(bundle.connectors, 'connectors', validateConnector, (c) => {
    if (out.connectors.some((x) => x.id === c.id)) out.errors.push({ file, message: `conector "${c.id}" repetido no pacote` })
    else out.connectors.push(c)
  })
  // O valor real de uma variável isSecret sai do documento antes da validação (que só aceita
  // __REQUIRED_SECRET__ ali) e vai para o vault, como no Postman.
  const environments = (bundle.environments ?? []).map((e) =>
    redactEnvironment(e, out.secrets, (env, message) => out.warnings.push({ source: `${name} › ${env}`, message }))
  )
  take<Environment>(environments, 'environments', validateEnvironment, (e) => {
    if (out.environments.some((x) => x.id === e.id)) out.errors.push({ file, message: `ambiente "${e.id}" repetido no pacote` })
    else out.environments.push(e)
  })
  take<Flow>(bundle.flows, 'flows', validateFlow, (f) => {
    if (out.flows!.some((x) => x.id === f.id)) out.errors.push({ file, message: `fluxo "${f.id}" repetido no pacote` })
    else out.flows!.push(f)
  })
  for (const [id, markdown] of Object.entries(bundle.docs ?? {})) {
    if (out.connectors.some((c) => c.id === id)) out.docs![id] = markdown
    else out.warnings.push({ source: name, message: `documentação de "${id}" ignorada: o conector não está no pacote.` })
  }
  // Pai que não veio no pacote precisa existir no projeto de destino; a camada de escrita confere.
  for (const c of out.connectors) {
    if (c.extends && !out.connectors.some((x) => x.id === c.extends)) {
      out.warnings.push({ source: name, message: `${c.id} herda de "${c.extends}", que não está no pacote: precisa existir no projeto.` })
    }
  }
  return out
}

function redactEnvironment(
  doc: unknown,
  secrets: ImportedSecret[],
  warn: (env: string, message: string) => void
): unknown {
  if (!isObject(doc) || typeof doc['id'] !== 'string' || !isObject(doc['variables'])) return doc
  const envId = doc['id']
  const variables: Record<string, unknown> = {}
  for (const [name, v] of Object.entries(doc['variables'])) {
    if (isObject(v) && v['isSecret'] === true && typeof v['value'] === 'string' && v['value'] !== '' && v['value'] !== REQUIRED_SECRET) {
      secrets.push({ environmentId: envId, variable: name, value: v['value'] })
      variables[name] = { ...v, value: REQUIRED_SECRET }
      warn(typeof doc['name'] === 'string' ? doc['name'] : envId, `${name} veio com valor no pacote: o valor foi para o arquivo local de segredos, fora do Git.`)
    } else {
      variables[name] = v
    }
  }
  return { ...doc, variables }
}
