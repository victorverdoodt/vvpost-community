import { REQUIRED_SECRET, type Connector, type Environment, type Flow } from '@vvpost/schemas'
import { resolveConnector } from '@vvpost/core/connectors/resolve'
import { describeAuth } from '@vvpost/core/connectors/summary'
import { isSensitiveName, REDACTED } from '@vvpost/core/sanitizer'
import { SENSITIVE_HEADERS } from '@vvpost/core/secrets'
import { isProtectedEnvironment } from '@vvpost/core/policy/protected'
import type { Draft, DraftSnapshot } from './apply'
import { ProjectOpError, type ProjectApplyResult, type ProjectOp } from './ops'
import { codeFingerprint, flowReviewKey } from './review'

/**
 * O que o usuário confirma em cada marca de revisão, para o app mostrar sem abrir o arquivo:
 * a auth e o destino efetivos do conector (com a herança) ou os nós de código do fluxo.
 */
export function reviewReasons(draft: Draft, keys: readonly string[]): Record<string, string> {
  const catalog = new Map([...draft.connectors].map(([id, e]) => [id, e.doc]))
  const reasons: Record<string, string> = {}
  for (const key of keys) {
    if (key.startsWith('flow:')) {
      const flow = draft.flows.get(key.slice('flow:'.length))?.doc
      const code = flow?.nodes.filter((n) => n.type === 'python' || n.type === 'plugin').map((n) => n.name) ?? []
      if (code.length) reasons[key] = `nós de código: ${code.join(', ')}`
      continue
    }
    try {
      const c = resolveConnector(key, catalog)
      const parts = [`auth: ${c.auth ? `${describeAuth(c.auth.config)} (de ${c.auth.from})` : 'nenhuma'}`]
      if (c.baseUrl) parts.push(`destino: ${c.baseUrl}${c.basePath}`)
      if (c.tls) parts.push(`mTLS de ${c.tls.from}`)
      reasons[key] = parts.join(' · ')
    } catch {
      // Herança quebrada: a validação do lote já recusou.
    }
  }
  return reasons
}

/**
 * Regras das escritas da IA pelo MCP (docs/mcp.md, "Editar o projeto"). A IA
 * organiza o projeto, mas não passa a mexer com credenciais:
 *
 * - nenhum valor de segredo entra pela IA (nem no vault: o usuário preenche no app);
 * - variável de nome de credencial só como segredo, e um segredo não vira texto puro;
 * - {{SEGREDO}} num fluxo é recusado: um nó pode mandar o valor para qualquer URL
 *   quando o usuário rodar o fluxo;
 * - auth, destino (origem da baseUrl e do token/login), headers de credencial e
 *   referências a segredos alterados num conector marcam o conector para revisão
 *   (review.ts): a IA só dispara com essa auth depois que o usuário confirmar no app;
 * - [REDACTED_SECRET] lido pela IA volta a ser o valor que estava no arquivo.
 */
export const aiGuard = {
  before(op: ProjectOp, draft: Draft): void {
    switch (op.op) {
      case 'storeSecret':
        throw new ProjectOpError(
          'a IA não grava valores de segredo; crie a variável com secret: true e o usuário preenche o valor no app (Git › pendências)'
        )
      case 'setVariable': {
        const current = draft.environments.get(op.environmentId)?.doc.variables[op.name]
        const secret = op.secret ?? current?.isSecret ?? false
        if (current?.isSecret && op.secret === false) {
          throw new ProjectOpError(`${op.name} é segredo em "${op.environmentId}"; a IA não transforma um segredo em texto puro`)
        }
        if (secret && op.value !== undefined) {
          throw new ProjectOpError(
            `${op.name}: a IA não grava valores de segredo; omita value (fica ${REQUIRED_SECRET}) e o usuário preenche no app`
          )
        }
        if (!secret && op.value !== undefined && isCredentialValue(op.name, op.value)) {
          throw new ProjectOpError(`${op.name} tem nome de credencial: crie com secret: true, sem value`)
        }
        return
      }
      case 'upsertEnvironment': {
        const doc = draft.environments.get(op.environment?.id)?.doc
        // Renomear não tira a proteção de produção: quem libera é o usuário, com "protected": false no arquivo.
        if (doc && op.environment.name !== undefined && isProtectedEnvironment(doc) && !isProtectedEnvironment({ ...doc, name: op.environment.name })) {
          throw new ProjectOpError(`"${doc.id}" é ambiente protegido (produção); a IA não muda o nome para tirar a proteção`)
        }
        const current = doc?.variables ?? {}
        for (const [name, v] of Object.entries(op.environment?.variables ?? {})) {
          if (current[name]?.isSecret && !v.isSecret && op.overwriteValues) {
            throw new ProjectOpError(`${name} é segredo em "${op.environment.id}"; a IA não transforma um segredo em texto puro`)
          }
          if (!v.isSecret && isCredentialValue(name, v.value)) {
            throw new ProjectOpError(`${name} tem nome de credencial: declare com isSecret: true e value ${REQUIRED_SECRET}`)
          }
        }
        return
      }
      default:
        return
    }
  },

  /**
   * A IA lê o projeto pelo sanitizer, então um valor que ela não pode ver volta como
   * [REDACTED_SECRET]. Ao gravar, cada [REDACTED_SECRET] volta a ser o valor que já
   * estava no mesmo lugar (mesmo id de conector, endpoint, cenário, variável ou nó);
   * sem valor anterior, é erro: a IA não tem como escrever o que não viu.
   */
  restore(draft: Draft, original: DraftSnapshot, result: ProjectApplyResult): void {
    const fix = <T>(doc: T, before: unknown, where: string, op: number): T => {
      const missing: string[] = []
      const out = restoreRedacted(doc, before, where, missing) as T
      for (const path of missing) {
        result.errors.push({ op, message: `${path} é ${REDACTED}: não há valor anterior nesse lugar para manter; use uma variável {{NOME}}` })
      }
      return out
    }
    for (const [id, e] of draft.connectors) {
      if (e.dirty) e.doc = fix(e.doc, original.connectors.get(draft.renamed.get(id) ?? id), id, e.op)
    }
    const envs = new Map(original.environments.map((env) => [env.id, env]))
    for (const [id, e] of draft.environments) if (e.dirty) e.doc = fix(e.doc, envs.get(id), id, e.op)
    for (const [id, e] of draft.flows) if (e.dirty) e.doc = fix(e.doc, original.flows.get(id), id, e.op)
    for (const [file, d] of draft.docs) {
      if (d.text?.includes(REDACTED)) result.errors.push({ op: d.op, message: `${file}: o texto tem ${REDACTED}; escreva a documentação sem valores de credencial` })
    }
  },

  after(draft: Draft, original: DraftSnapshot, result: ProjectApplyResult): void {
    const secrets = secretNames([...draft.environments.values()].map((e) => e.doc), original.environments)
    for (const [id, e] of draft.flows) {
      if (!e.dirty) continue
      const before = original.flows.get(id)
      const had = before ? new Set(walkRefs(outsideAuth(before), secrets, `fluxo ${id}`)) : new Set<string>()
      for (const ref of walkRefs(outsideAuth(e.doc), secrets, `fluxo ${id}`)) {
        if (!had.has(ref)) {
          result.errors.push({ op: e.op, message: `${ref.replace('\n', ' referencia o segredo ')}; num fluxo, a credencial vem da auth do conector do nó` })
        }
      }
      const code = e.doc.nodes.filter((n) => n.type === 'python' || n.type === 'plugin').map((n) => n.name)
      if (code.length) {
        result.warnings.push({
          op: e.op,
          message: `o fluxo "${id}" tem nós com código (${code.join(', ')}): o usuário deve revisar antes de rodar no app`
        })
      }
      // Código escrito ou mudado pela IA só roda pelo MCP depois que o usuário revisar (review.ts).
      const fp = codeFingerprint(e.doc)
      if (fp && fp !== (before ? codeFingerprint(before) : '')) result.review.push(flowReviewKey(id))
    }
  }
}

/** Arrays de objetos com id são casados pelo id (a IA pode reordenar endpoints e cenários). */
function restoreRedacted(value: unknown, before: unknown, path: string, missing: string[]): unknown {
  if (typeof value === 'string') {
    if (!value.includes(REDACTED)) return value
    if (typeof before === 'string') return before
    missing.push(path)
    return value
  }
  if (Array.isArray(value)) {
    const old = Array.isArray(before) ? before : []
    const byId = new Map(old.filter((x) => x && typeof x === 'object' && typeof x.id === 'string').map((x) => [x.id as string, x]))
    return value.map((item, i) => {
      const id = item && typeof item === 'object' && typeof item.id === 'string' ? (item.id as string) : undefined
      const match = id !== undefined ? byId.get(id) : old[i]
      return restoreRedacted(item, match, `${path}${id !== undefined ? `[${id}]` : `[${i}]`}`, missing)
    })
  }
  if (value && typeof value === 'object') {
    const old = before && typeof before === 'object' && !Array.isArray(before) ? (before as Record<string, unknown>) : {}
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreRedacted(v, old[k], `${path}.${k}`, missing)]))
  }
  return value
}

/** Valor literal numa variável cujo nome é de credencial (uma {{REF}} sozinha não conta). */
function isCredentialValue(name: string, value: unknown): boolean {
  return isSensitiveName(name) && typeof value === 'string' && value.trim() !== '' && !/^\s*\{\{[^{}]+\}\}\s*$/.test(value)
}

function secretNames(...envLists: Environment[][]): Set<string> {
  const names = new Set<string>()
  for (const envs of envLists) {
    for (const env of envs) {
      for (const [name, v] of Object.entries(env.variables)) {
        if (v.isSecret || v.value === REQUIRED_SECRET || isSensitiveName(name)) names.add(name)
      }
    }
  }
  return names
}

const TEMPLATE_REF = /\{\{\s*([^{}]+?)\s*\}\}/g
const isSensitiveHeader = (name: string) => SENSITIVE_HEADERS.has(name.toLowerCase()) || isSensitiveName(name)

/** "caminho\nSEGREDO" de cada {{SEGREDO}} no valor. */
function walkRefs(value: unknown, secrets: ReadonlySet<string>, path: string): string[] {
  const out: string[] = []
  const visit = (v: unknown, p: string): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(TEMPLATE_REF)) {
        const name = m[1]!.replace(/^\$totp:/, '').trim()
        if (secrets.has(name)) out.push(`${p}\n{{${name}}}`)
      }
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${p}[${i}]`))
    } else if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) {
        visit(k, p)
        visit(item, `${p}.${k}`)
      }
    }
  }
  visit(value, path)
  return out
}

/**
 * O que decide para onde vão as credenciais de cada conector: auth, mTLS, headers
 * de credencial (do conector, dos endpoints e dos cenários) e a origem da baseUrl
 * e das URLs de token/login em cada ambiente (variáveis comuns substituídas).
 * null: o conector não leva credencial nenhuma.
 */
export function connectorFingerprints(
  connectors: ReadonlyMap<string, Connector>,
  environments: readonly Environment[]
): Map<string, string | null> {
  const out = new Map<string, string | null>()
  const secrets = secretNames([...environments])
  const scopes = [new Map<string, string>()].concat(
    environments.map(
      (env) =>
        new Map(
          Object.entries(env.variables)
            .filter(([name, v]) => !v.isSecret && v.value !== REQUIRED_SECRET && !isSensitiveName(name))
            .map(([name, v]) => [name, String(v.value)])
        )
    )
  )
  for (const id of connectors.keys()) {
    let r
    try {
      r = resolveConnector(id, connectors)
    } catch {
      out.set(id, null)
      continue
    }
    const sensitive: Record<string, string> = {}
    for (const [name, value] of Object.entries(r.headers)) if (isSensitiveHeader(name)) sensitive[name.toLowerCase()] = value
    for (const e of r.endpoints) {
      for (const [name, value] of Object.entries(e.headers ?? {})) {
        if (isSensitiveHeader(name)) sensitive[`${e.id}:${name.toLowerCase()}`] = value
      }
      for (const s of e.scenarios ?? []) {
        for (const [name, value] of Object.entries(s.overrides?.headers ?? {})) {
          if (isSensitiveHeader(name) && value !== null) sensitive[`${e.id}/${s.id}:${name.toLowerCase()}`] = value
        }
      }
    }
    // Toda referência a segredo do conector (e dos pais) conta: um {{SEGREDO}} novo num corpo ou query também.
    const refs = walkRefs(
      { chain: r.chain.map((c) => connectors.get(c)?.config), endpoints: r.endpoints },
      secrets,
      'conector'
    ).sort()
    if (!r.auth && !r.tls && !Object.keys(sensitive).length && !refs.length) {
      out.set(id, null)
      continue
    }
    const auth = r.auth?.config
    const authUrl = auth?.type === 'oauth2' ? auth.tokenUrl : auth?.type === 'login' ? auth.request.url : undefined
    const targets = scopes.map((values) => {
      const fill = (text: string) => text.replace(TEMPLATE_REF, (whole, name: string) => values.get(name.trim()) ?? whole)
      const base = r.baseUrl === undefined ? undefined : fill(r.baseUrl)
      return [origin(base), authUrl === undefined ? null : origin(fill(authUrl), base)]
    })
    out.set(id, JSON.stringify({ auth: auth ?? null, tls: r.tls?.config ?? null, sensitive, refs, targets }))
  }
  return out
}

function origin(url: string | undefined, base?: string): string | null {
  if (url === undefined) return null
  try {
    return new URL(url, base).origin
  } catch {
    return url
  }
}

/**
 * O que num fluxo não é auth: os defaults e os nós de login (com cache) e OAuth2 de um fluxo-base são a
 * auth do conector que ele vira (docs/flows.md, Herança entre fluxos), então podem citar
 * segredos como o config.auth de um conector; o resto do fluxo, não.
 */
function outsideAuth(flow: Flow): Flow {
  const { defaults: _defaults, ...rest } = flow
  return { ...rest, nodes: flow.nodes.filter((n) => !(n.type === 'request' && n.cache) && n.type !== 'oauth2') }
}
