import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import connectorSchema from '@vvpost/schemas/schemas/connector.json' with { type: 'json' }
import environmentSchema from '@vvpost/schemas/schemas/environment.json' with { type: 'json' }
import flowSchema from '@vvpost/schemas/schemas/flow.json' with { type: 'json' }
import bundleSchema from '@vvpost/schemas/schemas/bundle.json' with { type: 'json' }
import docsSchema from '@vvpost/schemas/schemas/docs.json' with { type: 'json' }
import type { Connector } from '@vvpost/schemas'
import { loadFlows } from '@vvpost/core/flows/workspace'
import { buildRegistry } from '@vvpost/core/connectors/registry'
import type { DocScope, ImportConflictMode, ImportPlanInput } from '@shared/ipc'
import { exportAs, ExportError, type ExportSelection } from '../bundle/export'
import { isForeignImport, loadProject, prepareSources, type PreparedImport } from '../importers'
import { isBundle } from '../importers/bundle'
import { isOpenApi } from '../importers/openapi'
import { planImport } from '../importers/plan'
import { syncSpecSources } from '../importers/spec-sync'
import { convertPostman, type PostmanSource } from '../importers/postman'
import { fetchImportUrl, isUrl, parseImportText, readImportFile, readSourceLocation } from '../importers/source'
import { applyProjectOps, OP_NAMES, readReviewMarks, type ProjectApplyResult, type ProjectOp } from '../project'
import { docsFileOf } from '../project/apply'
import { opsInWorkspaceFormat } from '../project/save-connector'
import { lintAfterWrite } from './lint-tools'
import { sliceText } from './budget'
import { load, ToolError, type McpTool, type ToolContext } from './tools'
import { expectSchema, fileVersions, safeRel, versionConflicts, versionOf, type Expected } from './versions'

/** Coleção do Postman colada pela IA. */
const MAX_IMPORT_CHARS = 20 * 1024 * 1024
/** Páginas de documentação numa chamada de write_docs_page. */
const MAX_DOC_PAGES = 50

/** Ops do edit_project que não são do catálogo: o MCP as resolve antes do lote (planReplace e as páginas). */
const PAGE_OPS = ['replaceReferences', 'writePage'] as const

// Vai na descrição do edit_project: só as assinaturas. Os formatos inteiros ficam no get_schema.
const OPS_HELP = `Ops (campo op; ? = opcional). As de conector, endpoint e cenário valem num fluxo-base e gravam nos fluxos dele.
- upsertConnector {connector, file?} · patchConnector {id, set: {name?, description?, version?, extends?, config?}} (null remove; config mescla por chave e headers por nome: {"Nome": "valor"})
- moveConnector {id, newId?, extends?, file?} (filhos e fluxos acompanham; extends null: raiz) · deleteConnector {id}
- upsertEndpoint {connectorId, endpoint (requiresAuth?: true exige credencial, false é público; o vvpost run confere), keepScenarios?=true, index?} · moveEndpoint {connectorId, endpointId, toConnectorId?, newId?, index?} · deleteEndpoint {connectorId, endpointId}
- upsertScenario {connectorId, endpointId, scenario: {id, name, overrides?: {body?, headers?, query?, pathParams?, rawPathParams?}, assertions: [{target, operator, expected?}]}} · deleteScenario {connectorId, endpointId, scenarioId}
  target: status | responseTimeMs | body | body.<caminho> | headers.<nome>; operator: equals, notEquals, lessThan(OrEqual), greaterThan(OrEqual), contains, matches, exists, notExists, matchesSchema, matchesExample (body, sem expected: o schema do exemplo de resposta do mesmo status)
- setBodyField {connectorId, endpointId, path ("a.b", "itens[].sku"), field: {type, required?, description?, enum?, format?, items?, default?, example?, minimum?, maximum?, minLength?, maxLength?, pattern?} | null}
- upsertSchema {name, schema} · setSchemaField {name, path, field, fillExamples? (põe o campo, com field.example, nos exemplos que citam o schema)} · deleteSchema {name} · extractSchemas {minUses?=2} (migração: $defs repetidos viram compartilhados)
  Schema compartilhado (schemas/<name>.schema.json): cite com {"$ref": "schema:<name>"} no bodySchema, no schema de um exemplo ou dentro de outro schema; editar o schema muda todos os usos. setBodyField num corpo que é {"$ref": "schema:X"} edita o X.
- setBodySchema {connectorId, endpointId, schema? (null remove), fromBody?} · upsertExample {connectorId, endpointId, example: {id, name, status, headers?, body?, delayMs?, schema? (JSON Schema do corpo; o validate reprova o exemplo fora dele)}} · deleteExample {connectorId, endpointId, exampleId}
- upsertEnvironment {environment: {id, name, description?, variables?}, overwriteValues?} · deleteEnvironment {id}
- setVariable {environmentId, name, value?, secret? (grava __REQUIRED_SECRET__), description?, placeholder?, overwrite?} · deleteVariable {environmentId, name}
- upsertFlow {flow, file?} · deleteFlow {id} · migrateConnector {id} (formato antigo para fluxos)
- writeDoc {connectorId, markdown} (seção de endpoint: título terminado em {#endpointId}; "" apaga)
- replaceReferences {from, to, in?} (como replace_references; roda antes das outras ops do lote, em qualquer posição; find_references.exact mostra onde troca) · writePage {file, edits: [{find, replace}] | markdown} (página em docs/, como write_docs_page)
  Uma mudança de API numa chamada: replaceReferences para o nome que mudou, setSchemaField {fillExamples: true} para o campo novo e writePage para o texto do guia, tudo ou nada.
Formato de uma peça: get_schema { name: "connector", part: "scenario" } (ou endpoint, responseExample; no flow, requestNode).`

const getSchema: McpTool = {
  name: 'get_schema',
  title: 'JSON Schema dos arquivos do VVPost',
  description:
    'O JSON Schema v1 de connector, environment, flow, bundle ou docs (vvpost.docs.json), para montar documentos do edit_project. Vem compacto, sem as descrições (metade do tamanho); full: true traz tudo.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { enum: ['connector', 'environment', 'flow', 'bundle', 'docs'] },
      part: { type: 'string', description: 'Só uma definição e as que ela usa (ex.: scenario, endpoint, responseExample, requestNode).' },
      full: { type: 'boolean' }
    }
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async call(args) {
    const schema = { connector: connectorSchema, environment: environmentSchema, flow: flowSchema, bundle: bundleSchema, docs: docsSchema }[
      args['name'] as 'connector'
    ] as Record<string, unknown>
    const part = typeof args['part'] === 'string' ? args['part'] : undefined
    const picked = part ? schemaPart(schema, part) : schema
    return args['full'] === true ? picked : withoutProse(picked)
  }
}

/** Uma definição ($defs) do schema e as que ela referencia, para ler só o formato que vai escrever. */
function schemaPart(schema: Record<string, unknown>, part: string): unknown {
  const defs = (schema['$defs'] ?? {}) as Record<string, unknown>
  if (!(part in defs)) {
    throw new ToolError(`"${part}" não é uma definição deste schema`, { code: 'NOT_FOUND', hint: `partes: ${Object.keys(defs).join(', ')}` })
  }
  const used = new Map<string, unknown>()
  const visit = (name: string) => {
    if (used.has(name) || !(name in defs)) return
    used.set(name, defs[name])
    for (const m of JSON.stringify(defs[name]).matchAll(/"#\/\$defs\/([^"]+)"/g)) visit(m[1]!)
  }
  visit(part)
  return { $ref: `#/$defs/${part}`, $defs: Object.fromEntries(used) }
}

/** O schema sem o texto para pessoas (descrições, títulos, exemplos): a forma inteira, com metade dos tokens. */
function withoutProse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProse)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      // Uma propriedade chamada description ou examples (um objeto de schema) fica; o texto e a lista de exemplos saem.
      .filter(([k, v]) => !(['description', 'title', 'examples', '$comment', 'markdownDescription'].includes(k) && (typeof v !== 'object' || Array.isArray(v))))
      .map(([k, v]) => [k, withoutProse(v)])
  )
}

const getSource: McpTool = {
  name: 'get_source',
  title: 'Arquivo do projeto como está no disco',
  description:
    'Um documento do projeto como está no arquivo, sem a herança aplicada, para editar com edit_project: connector (com endpoints e cenários), environment, flow ou doc (o Markdown do conector). ' +
    'Um conector guardado como fluxo-base vem com os arquivos dos fluxos (flows); um fluxo que é base ou endpoint vem com is. ' +
    'Schemas compartilhados vêm citados ({"$ref": "schema:<nome>"}); kind schema traz um deles e quem o usa. ' +
    'Sem id, lista os fluxos ou os schemas (connector e environment estão em get_api_catalog). Segredos aparecem como __REQUIRED_SECRET__ ou [REDACTED_SECRET].',
  inputSchema: {
    type: 'object',
    required: ['kind'],
    additionalProperties: false,
    properties: {
      kind: { enum: ['connector', 'environment', 'flow', 'doc', 'schema'] },
      id: { type: 'string', description: 'Id do conector (connector e doc), do ambiente, do fluxo ou nome do schema compartilhado.' },
      endpoint: { type: 'string', description: 'Com connector: só este endpoint inteiro (os outros vêm só pelo id).' },
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Vários do mesmo kind numa chamada, no lugar de id.' },
      offset: { type: 'integer', minimum: 0, description: 'Com doc: de que caractere continuar o Markdown longo (o truncated.next.offset da resposta anterior).' }
    }
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async call(args, ctx) {
    // Vários de uma vez: uma chamada em vez de uma por conector (cada item traz o próprio erro, se houver).
    if (Array.isArray(args['ids'])) {
      const items: unknown[] = []
      for (const one of args['ids'] as string[]) {
        try {
          items.push({ id: one, ...((await getSource.call({ kind: args['kind'], id: one }, ctx)) as object) })
        } catch (err) {
          if (!(err instanceof ToolError)) throw err
          items.push({ id: one, error: err.message, ...err.details })
        }
      }
      return { items }
    }
    const ws = await load(ctx)
    const kind = args['kind'] as 'connector' | 'environment' | 'flow' | 'doc' | 'schema'
    const id = typeof args['id'] === 'string' ? args['id'] : undefined
    if (kind === 'schema') {
      const usesOf = (name: string) => ws.schemaUses?.get(name) ?? []
      if (!id) {
        return {
          schemas: [...(ws.schemas?.values() ?? [])].map((s) => ({ name: s.name, file: s.file, uses: usesOf(s.name).length, ...(s.shared && { shared: s.shared }) }))
        }
      }
      const s = ws.schemas?.get(id)
      if (!s) throw new ToolError(`schema "${id}" não existe`, { code: 'NOT_FOUND', hint: 'get_source { kind: "schema" } sem id lista os schemas compartilhados' })
      return { file: s.file, ...(await versionsOf(ctx, [s.file])), schema: s.schema, uses: usesOf(id), ...(s.shared && { shared: s.shared }) }
    }
    if (kind === 'flow') {
      const flows = await loadFlows(ctx.workspaceDir)
      // O que cada fluxo é no catálogo: a base de um conector ou o endpoint dele.
      const roles = new Map<string, { connector: string; endpoint?: string }>()
      for (const [key, file] of ws.flowSources ?? []) {
        const [connector, endpoint] = key.split('/') as [string, string?]
        roles.set(file, { connector, ...(endpoint && { endpoint }) })
      }
      if (!id) {
        return {
          flows: flows.flows.map(({ file, flow }) => ({
            id: flow.id,
            name: flow.name,
            file,
            nodes: flow.nodes.length,
            ...(roles.has(file) && { is: roles.get(file) })
          })),
          ...(flows.issues.length && { issues: flows.issues })
        }
      }
      const found = flows.flows.find((f) => f.flow.id === id)
      if (!found) throw new ToolError(`fluxo "${id}" não existe`, { code: 'NOT_FOUND', hint: 'get_source { kind: "flow" } sem id lista os fluxos' })
      return {
        file: found.file,
        ...(await versionsOf(ctx, [found.file])),
        flow: found.flow,
        ...(roles.has(found.file) && { is: roles.get(found.file) })
      }
    }
    if (!id) throw new ToolError(`informe o id do ${kind}`)
    if (kind === 'environment') {
      const env = ws.environments.get(id)
      if (!env) throw new ToolError(`ambiente "${id}" não existe`)
      return { environment: env }
    }
    const file = ws.connectorFiles.get(id)
    if (!file) throw new ToolError(`conector "${id}" não existe`, { code: 'NOT_FOUND', hint: 'get_api_catalog lista os conectores' })
    if (kind === 'connector') {
      const marks = await readReviewMarks(ctx.workspaceDir)
      // Como está nos arquivos: os schemas compartilhados citados, não copiados (gravar de volta não duplica).
      const whole = ws.unresolved?.get(id) ?? ws.connectors.get(id)!
      const only = typeof args['endpoint'] === 'string' ? args['endpoint'] : undefined
      if (only && !whole.endpoints?.some((e) => e.id === only)) {
        throw new ToolError(`endpoint "${only}" não existe em "${id}"`, { code: 'NOT_FOUND', hint: `get_source { kind: "connector", id: "${id}" } lista os endpoints` })
      }
      // Com endpoint, só ele vem inteiro: ler um conector de 20 endpoints para mexer em um custa caro.
      const connector = only
        ? { ...whole, endpoints: whole.endpoints!.filter((e) => e.id === only), otherEndpoints: whole.endpoints!.filter((e) => e.id !== only).map((e) => e.id) }
        : whole
      const shown = only ? [only] : (whole.endpoints ?? []).map((e) => e.id)
      const endpointFiles = Object.fromEntries(shown.map((e) => [e, ws.flowSources?.get(`${id}/${e}`)]))
      const flows = ws.flowSources?.get(id) === file && { flows: { base: file, endpoints: endpointFiles } }
      const files = [file, ...(flows ? Object.values(endpointFiles).filter((f): f is string => !!f) : [])]
      return { file, ...(await versionsOf(ctx, files)), connector, ...flows, ...(marks[id] && { review: reviewNote }) }
    }
    const docs = docsFileOf(file)
    const text = await readFile(join(ctx.workspaceDir, docs), 'utf8').catch(() => undefined)
    return {
      file: docs,
      version: versionOf(text),
      ...(text === undefined
        ? { exists: false, markdown: '' }
        : (({ text: markdown, truncated }) => ({ markdown, ...(truncated && { truncated }) }))(sliceText(text, Number(args['offset'] ?? 0))))
    }
  }
}

/**
 * Versões dos arquivos lidos, para a IA mandar em expect na escrita (concorrência otimista).
 * Arquivos de fora do projeto (Compartilhado, outro projeto) são só leitura e ficam de fora.
 */
async function versionsOf(ctx: ToolContext, files: string[]) {
  const own = files.filter((f) => !f.startsWith('project:') && !f.startsWith('..') && !isAbsolute(f))
  if (!own.length) return {}
  const versions = await fileVersions(ctx.workspaceDir, own)
  return own.length === 1 ? { version: versions[own[0]!] } : { versions }
}

const reviewNote =
  'auth, destino ou credenciais alterados pela IA: até o usuário revisar no app (salvar o conector no editor do Catálogo), execute_dry_run só monta as requisições (plan)'

function writesBlocked(ctx: ToolContext): void {
  if (ctx.readOnly) throw new ToolError('servidor MCP em modo somente leitura: nada é gravado no projeto', { code: 'BLOCKED' })
  if (ctx.reference) {
    throw new ToolError(`o projeto "${ctx.reference.project}" é uma referência só para leitura (${ctx.reference.source} ${ctx.reference.location}): a mudança vai no repositório de origem`, { code: 'BLOCKED' })
  }
  if (ctx.noWrite) throw new ToolError('a edição do projeto está desligada neste servidor MCP (--no-write)', { code: 'BLOCKED' })
}

async function withPageVersions<T extends { file: string }>(ctx: ToolContext, files: T[]): Promise<(T & { version?: string | null })[]> {
  const pages = files.filter((f) => f.file.startsWith('docs/')).map((f) => f.file)
  const versions = await fileVersions(ctx.workspaceDir, pages)
  return files.map((f) => (f.file in versions ? { ...f, version: versions[f.file] } : f))
}

/** expect da IA conferido com o disco antes de gravar: diferente, nada é gravado. */
async function assertExpected(ctx: ToolContext, expect: unknown): Promise<void> {
  if (expect === undefined) return
  const conflicts = await versionConflicts(ctx.workspaceDir, expect as Expected).catch((err: Error) => {
    throw new ToolError(err.message, { code: 'INVALID_ARGS' })
  })
  if (conflicts.length) {
    throw new ToolError('nada foi gravado: arquivos mudaram no disco depois da leitura', {
      code: 'CONFLICT',
      conflicts,
      hint: 'releia (get_docs_project ou get_source devolvem a versão atual), refaça a mudança sobre o conteúdo novo e mande com expect atualizado'
    })
  }
}

/** Resultado do lote para a IA: os textos dos arquivos ficam de fora (ela já sabe o que mandou). */
function report(result: ProjectApplyResult, ops: ProjectOp[]) {
  const where = (i: number) => (i >= 0 ? `ops[${i}] (${ops[i]?.op})` : 'lote')
  if (result.conflicts?.length) {
    // Outra pessoa (ou agente) gravou no meio: o lote não vale mais sobre esses arquivos.
    throw new ToolError('nada foi gravado: arquivos mudaram no disco depois da leitura', {
      code: 'CONFLICT',
      conflicts: result.conflicts,
      hint: 'releia os arquivos (get_source devolve a versão atual), refaça o lote sobre o conteúdo novo e mande com expect atualizado'
    })
  }
  const written = !result.dryRun && result.ok && result.changes.length > 0
  return {
    ok: result.ok,
    ...(result.dryRun && { dryRun: true, note: 'nada foi gravado; mande de novo sem dryRun para aplicar' }),
    ...(!result.ok && { code: 'VALIDATION', note: 'nada foi gravado: corrija os erros e mande o lote inteiro de novo' }),
    ...(result.ok && !result.changes.length && { unchanged: true, note: 'o projeto já estava assim: nada a gravar' }),
    // Gravado, cada mudança traz a versão nova do arquivo: o próximo lote manda em expect sem reler.
    changes: result.changes.map((c) => ({ path: c.path, action: c.action, ...(written && c.after !== undefined && { version: versionOf(c.after) }) })),
    ...(result.errors.length && { errors: result.errors.map((e) => ({ at: where(e.op), message: e.message })) }),
    ...(result.warnings.length && { warnings: result.warnings.map((e) => ({ at: where(e.op), message: e.message })) }),
    ...(result.review.length && { review: reviewReport(result.review) })
  }
}

function reviewReport(keys: string[]) {
  const flows = keys.filter((k) => k.startsWith('flow:')).map((k) => k.slice('flow:'.length))
  const connectors = keys.filter((k) => !k.startsWith('flow:'))
  return {
    ...(connectors.length && { connectors, note: reviewNote }),
    ...(flows.length && { flows, flowNote: flowReviewNote })
  }
}

const flowReviewNote =
  'nós de código (Python, plugin) escritos pela IA: até o usuário revisar (salvar o fluxo no Flow Studio do app), execute_flow só mostra o plano'

const editProject: McpTool = {
  name: 'edit_project',
  title: 'Editar o projeto do VVPost',
  description:
    'Lote atômico e em ordem de mudanças em conectores, endpoints, cenários, ambientes, variáveis, fluxos e docs: valida schema, herança e credenciais antes de gravar; com erro nada muda. ' +
    'Sem dryRun valida e grava num passo só e devolve o catálogo conferido (catalog); dryRun é opcional e devolve planId. Credencial só como {{VAR}} de variável secreta, e só na auth, no mTLS e em headers de credencial; mudar auth ou destino pede revisão da pessoa.\n\n' +
    OPS_HELP,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ops: {
        type: 'array',
        minItems: 1,
        items: { type: 'object', required: ['op'], properties: { op: { enum: [...OP_NAMES.filter((o) => o !== 'storeSecret'), ...PAGE_OPS] } } }
      },
      dryRun: { type: 'boolean', description: 'true: só valida e mostra o que mudaria, e devolve planId.' },
      planId: {
        type: 'string',
        description: 'Aplica o lote de um dryRun anterior sem mandar ops de novo; recusado com CONFLICT se algum arquivo mudou desde o dryRun.'
      },
      expect: expectSchema
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    writesBlocked(ctx)
    await load(ctx)
    let ops = args['ops'] as ProjectOp[] | undefined
    let expect = args['expect'] as Expected | undefined
    const planId = typeof args['planId'] === 'string' ? args['planId'] : undefined
    if (planId) {
      const plan = dryRunPlans.get(planId)
      if (!plan || plan.dir !== ctx.workspaceDir) {
        throw new ToolError(`planId "${planId}" não existe neste projeto`, {
          code: 'NOT_FOUND',
          hint: 'os planos valem só nesta sessão do servidor e no mesmo projeto: rode o dryRun de novo'
        })
      }
      if (ops) throw new ToolError('mande ops ou planId, não os dois', { code: 'INVALID_ARGS' })
      ops = plan.ops
      expect = { ...plan.expect, ...expect }
    }
    if (!ops) throw new ToolError('mande ops (ou o planId de um dryRun)', { code: 'INVALID_ARGS' })
    const options = {
      actor: 'ai' as const,
      ...(expect && { expect }),
      checkText: (_path: string, content: string) =>
        ctx.sanitizer.leaks(content) ? 'contém o valor de uma credencial real; use uma variável {{NOME}} marcada como segredo' : undefined
    }
    if (ops.some((o) => (PAGE_OPS as readonly string[]).includes(o.op))) {
      if (planId) throw new ToolError('lote com replaceReferences ou writePage não vira planId: mande as ops de novo', { code: 'INVALID_ARGS' })
      return editWithPages(ctx, ops as unknown as Record<string, unknown>[], args['dryRun'] === true, expect, options)
    }
    // Conector novo num workspace em fluxos nasce como fluxo-base, como no app e no import. Se a
    // conversão não passa nas regras da IA (um {{SEGREDO}} num header do endpoint, por exemplo),
    // o lote grava como veio, no formato antigo.
    if (!planId) {
      const inFormat = await opsInWorkspaceFormat(ctx.workspaceDir, ops)
      if (inFormat !== ops && (await applyProjectOps(ctx.workspaceDir, inFormat, { ...options, dryRun: true })).ok) ops = inFormat
    }
    const result = await applyProjectOps(ctx.workspaceDir, ops, { ...options, dryRun: args['dryRun'] === true })
    if (result.ok && !result.dryRun) ctx.auth.clear()
    if (planId && !result.dryRun) dryRunPlans.delete(planId)
    const out = report(result, ops)
    // Gravado: o catálogo já conferido vai junto, e o agente não precisa de outro get_api_catalog.
    if (!result.dryRun && result.ok && result.changes.length) return { ...out, catalog: await catalogCheck(ctx), ...(await afterWrite(ctx)) }
    if (!result.dryRun || !result.ok || !result.changes.length) return out
    // O lote validado fica guardado: aplicar é mandar só o planId, sobre os mesmos arquivos.
    const id = createHash('sha256').update(`${ctx.workspaceDir}\0${JSON.stringify(ops)}`).digest('base64url').slice(0, 12)
    dryRunPlans.delete(id)
    dryRunPlans.set(id, {
      dir: ctx.workspaceDir,
      ops,
      expect: { ...expect, ...Object.fromEntries(result.changes.map((c) => [c.path, versionOf(c.before)])) }
    })
    while (dryRunPlans.size > MAX_DRY_RUN_PLANS) dryRunPlans.delete(dryRunPlans.keys().next().value!)
    return { ...out, planId: id, note: 'nada foi gravado; para aplicar, mande edit_project { planId } (sem repetir ops)' }
  }
}


type PageEdit = { find: string; replace: string }

/** "cep" com as aspas da chave JSON vira cep: a troca é por palavra, não pelo trecho do arquivo. */
const unquote = (v: unknown) => (typeof v === 'string' && /^(["'`]).+\1$/.test(v) ? v.slice(1, -1) : v)

const REPLACE_SCOPE_HINT =
  'from é o nome sem aspas, com a mesma caixa; in aceita o id de um conector, schema:<Nome>, um arquivo ou uma pasta (flows/loja-api, schemas, docs/); sem in, o projeto inteiro'

/**
 * Lote do edit_project com trocas de nome e páginas: a mudança de API inteira (renomear um campo,
 * acrescentar outro e contar nas páginas) numa chamada, tudo ou nada. As trocas vêm primeiro e
 * partem do projeto como está; as páginas são gravadas antes do catálogo e voltam se ele falhar.
 */
async function editWithPages(
  ctx: ToolContext,
  raw: Record<string, unknown>[],
  dryRun: boolean,
  expect: Expected | undefined,
  options: Parameters<typeof applyProjectOps>[2]
) {
  await assertExpected(ctx, expect)
  const docs = await import('@vvpost/core/docs')
  const scan: ReplaceScan = { count: 0, changes: [], nearMisses: [], skipped: [] }
  const replaced = new Map<string, ProjectOp>()
  let rest: ProjectOp[] = []
  const pages = new Map<string, { before: string | null; after: string }>()
  const renames: { from: string; to: string }[] = []
  const text = async (file: string) => pages.get(file)?.after ?? (await readFile(join(ctx.workspaceDir, file), 'utf8').catch(() => null))
  const fail = (i: number, message: string, code = 'INVALID_ARGS', hint?: string) => {
    throw new ToolError(`ops[${i}] (${String(raw[i]!['op'])}): ${message}; nada foi gravado`, { code, ...(hint && { hint }) })
  }
  // De que op do agente veio cada op do lote, para os erros apontarem ops[i] do que ele mandou.
  const origin = new Map<string, number>()
  const restOrigin: number[] = []
  // As trocas rodam primeiro, sobre o que está gravado, em qualquer posição que venham no lote; as
  // páginas e as ops do catálogo vêm depois (um find copiado de antes da troca ainda acha o trecho).
  const order = [...raw.keys()].sort((a, b) => Number(raw[b]!['op'] === 'replaceReferences') - Number(raw[a]!['op'] === 'replaceReferences'))
  for (const i of order) {
    const op = raw[i]!
    if (op['op'] === 'replaceReferences') {
      const from = unquote(op['from'])
      const to = unquote(op['to'])
      if (typeof from !== 'string' || from.length < 2 || typeof to !== 'string' || from === to) fail(i, 'mande from (2 letras ou mais) e to, diferentes')
      const scope = Array.isArray(op['in']) ? (op['in'] as string[]) : undefined
      const count = scan.count
      const plan = await planReplace(ctx, from as string, to as string, scope, scan, text, replaced)
      if (scan.count === count) {
        fail(i, `"${String(from)}" não aparece como palavra inteira${scope ? ` em ${scope.join(', ')}` : ''}`, 'VALIDATION', REPLACE_SCOPE_HINT)
      }
      for (const o of plan.ops) {
        replaced.set(replaceKey(o), o)
        origin.set(replaceKey(o), i)
      }
      for (const p of plan.pages) pages.set(p.file, { before: pages.has(p.file) ? pages.get(p.file)!.before : p.before, after: p.after })
      renames.push({ from: from as string, to: to as string })
    } else if (op['op'] === 'writePage') {
      const file = op['file']
      const edits = op['edits'] as PageEdit[] | undefined
      const markdown = op['markdown']
      if (typeof file !== 'string' || !docs.normalizeRel(file).startsWith('docs/')) fail(i, 'file é uma página em docs/')
      if ((typeof markdown === 'string') === Array.isArray(edits)) fail(i, 'mande markdown (o texto inteiro) ou edits, um dos dois')
      const current = await text(file as string)
      let after = markdown as string
      if (edits) {
        try {
          after = applyEdits(file as string, current, edits)
        } catch (err) {
          if (!(err instanceof EditMismatch)) throw err
          // O find copiado da página de antes da troca: procura com os nomes já trocados.
          const renamed = (t: string) => renames.reduce((acc, r) => acc.replace(wordPattern(r.from), () => r.to), t)
          try {
            after = applyEdits(file as string, current, edits.map((e) => ({ find: renamed(e.find), replace: e.replace })))
          } catch {
            fail(i, err.message, 'VALIDATION', 'find precisa aparecer exatamente uma vez no texto atual da página')
          }
        }
      }
      pages.set(file as string, { before: pages.has(file as string) ? pages.get(file as string)!.before : current, after })
    } else {
      rest.push(op as unknown as ProjectOp)
      restOrigin.push(i)
    }
  }
  const converted = await opsInWorkspaceFormat(ctx.workspaceDir, rest)
  if (converted.length === rest.length) rest = converted
  const ops = [...replaced.values(), ...rest]
  const from = [...[...replaced.keys()].map((k) => origin.get(k)!), ...restOrigin]
  const batchReport = (result: ProjectApplyResult) =>
    report(
      { ...result, errors: result.errors.map((e) => ({ ...e, op: from[e.op] ?? e.op })), warnings: result.warnings.map((e) => ({ ...e, op: from[e.op] ?? e.op })) },
      raw as unknown as ProjectOp[]
    )
  const changed = [...pages].filter(([, p]) => p.before !== p.after)
  const leak = changed.find(([, p]) => ctx.sanitizer.leaks(p.after))
  if (leak) throw new ToolError(`${leak[0]} ficaria com o valor de uma credencial; nada foi gravado`, { code: 'VALIDATION' })
  const shown = {
    ...(scan.count && { replaced: scan.count }),
    ...(scan.nearMisses.length && { nearMisses: scan.nearMisses.slice(0, MAX_REPLACE_SHOWN) }),
    ...(scan.skipped.length && { skipped: scan.skipped.slice(0, MAX_REPLACE_SHOWN) })
  }
  const pageList = changed.map(([file, p]) => ({ file, ...(p.after === '' && { deleted: true }) }))
  const checked = ops.length ? await applyProjectOps(ctx.workspaceDir, ops, { ...options, dryRun: true }) : undefined
  if (checked && !checked.ok) return { ...batchReport(checked), ...shown }
  if (dryRun) {
    return { ok: true, dryRun: true, ...(checked && { changes: batchReport(checked).changes }), pages: pageList, ...shown, note: 'nada foi gravado; mande o lote de novo sem dryRun' }
  }
  const ws = await load(ctx)
  const written: { path: string; before: string | null }[] = []
  const undo = async () => {
    for (const { path, before } of written.reverse()) await (before === null ? rm(path, { force: true }) : writeFile(path, before)).catch(() => {})
  }
  try {
    for (const [file, p] of changed) {
      await docs.writeDocsPage(ws, file, p.after)
      written.push({ path: join(ctx.workspaceDir, docs.normalizeRel(file)), before: p.before })
    }
  } catch (err) {
    await undo()
    if (err instanceof docs.DocsError) throw new ToolError(`${err.message}; nada foi gravado`, { code: 'VALIDATION' })
    throw err
  }
  const applied = ops.length ? await applyProjectOps(ctx.workspaceDir, ops, options) : undefined
  if (applied && (!applied.ok || applied.conflicts?.length)) {
    await undo()
    return { ...batchReport(applied), ...shown }
  }
  if (applied) ctx.auth.clear()
  return {
    ...(applied ? batchReport(applied) : { ok: true }),
    pages: pageList,
    ...shown,
    catalog: await catalogCheck(ctx),
    ...(await afterWrite(ctx))
  }
}

/** As contagens e os avisos do catálogo depois de uma escrita (o que o get_api_catalog { view: "issues" } diria). */
async function catalogCheck(ctx: ToolContext) {
  const ws = await load(ctx)
  const [registry, flows] = await Promise.all([buildRegistry(ws), loadFlows(ctx.workspaceDir)])
  const issues = [...registry.issues, ...flows.issues]
  return {
    connectors: registry.connectors.length,
    endpoints: registry.connectors.reduce((n, c) => n + c.endpoints.length, 0),
    scenarios: registry.connectors.reduce((n, c) => n + c.endpoints.reduce((m, e) => m + e.scenarios.length, 0), 0),
    issues: issues.length,
    ...(issues.length && { firstIssues: issues.slice(0, 5) })
  }
}

/**
 * O que uma escrita deixou para trás e o agente não veria sozinho: diretivas do documento do
 * projeto que agora apontam para o que não existe (um conector apagado, por exemplo) e PDFs em
 * docs/export mais velhos que a mudança. E os achados novos do lint (lint-tools.ts).
 */
async function afterWrite(ctx: ToolContext, checkDocs = true) {
  const docs = await import('@vvpost/core/docs')
  const project = await docs.loadDocsProject(ctx.workspaceDir)
  const out: { documentErrors?: unknown[]; stalePdf?: string[]; hint?: string } = {}
  if (checkDocs && project.source !== null) {
    const compiled = await compileProjectDocs(ctx, project.config, project.source).catch(() => null)
    const errors = compiled?.composed.diagnostics.filter((d) => d.severity === 'error') ?? []
    if (errors.length) out.documentErrors = errors.slice(0, 5)
  }
  const exportDir = join(ctx.workspaceDir, 'docs', 'export')
  const pdfs = (await readdir(exportDir).catch(() => [] as string[])).filter((f) => f.toLowerCase().endsWith('.pdf'))
  if (pdfs.length) out.stalePdf = pdfs.map((f) => `docs/export/${f}`)
  const hints = [
    ...(out.documentErrors ? ['o documento do projeto tem diretivas quebradas por esta mudança: corrija com write_docs_page (edits)'] : []),
    ...(out.stalePdf ? ['o PDF ficou mais velho que o projeto: export_docs gera de novo'] : [])
  ]
  if (hints.length) out.hint = hints.join('; ')
  return { ...out, ...(await lintAfterWrite(ctx)) }
}

/** Lotes validados por dryRun, para aplicar pelo planId sem a IA reenviar as operações. */
const dryRunPlans = new Map<string, { dir: string; ops: ProjectOp[]; expect: Expected }>()
const MAX_DRY_RUN_PLANS = 20

const importPostman: McpTool = {
  name: 'import_postman',
  title: 'Converter uma coleção do Postman',
  description:
    'Converte uma coleção do Postman (v2.0/v2.1) e ambientes em operações do edit_project (conector por pasta, endpoints, ambientes); sem apply devolve as operações para ajustar, com apply: true grava (onConflict para o que já existe). Segredos viram __REQUIRED_SECRET__ para a pessoa preencher.',
  inputSchema: {
    type: 'object',
    required: ['collection'],
    additionalProperties: false,
    properties: {
      collection: { description: 'A coleção do Postman: objeto JSON ou o texto do arquivo.' },
      environments: { type: 'array', items: {}, description: 'Ambientes exportados do Postman (objetos ou textos).' },
      apply: { type: 'boolean', description: 'true: aplica as operações (com dryRun, só valida).' },
      dryRun: { type: 'boolean' },
      onConflict: {
        enum: ['error', 'merge', 'replace'],
        description:
          'Com apply, para conectores e ambientes que já existem. error (padrão): recusa; merge: acrescenta endpoints e variáveis sem tocar no resto (endpoints de mesmo id são substituídos mantendo os cenários); replace: substitui os documentos.'
      }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    const parse = (v: unknown, what: string): unknown => {
      if (typeof v !== 'string') return v
      if (v.length > MAX_IMPORT_CHARS) throw new ToolError(`${what} maior que ${MAX_IMPORT_CHARS / 1024 / 1024} MB`)
      try {
        return JSON.parse(v)
      } catch (err) {
        throw new ToolError(`${what}: JSON inválido (${(err as Error).message})`)
      }
    }
    const sources: PostmanSource[] = [
      { file: 'collection.json', data: parse(args['collection'], 'collection') },
      ...((args['environments'] as unknown[] | undefined) ?? []).map((e, i) => ({
        file: `environment-${i + 1}.json`,
        data: parse(e, `environments[${i}]`)
      }))
    ]
    const converted = convertPostman(sources)
    // Os valores tirados da coleção não voltam para a IA nem em mensagens de erro.
    for (const s of converted.secrets) ctx.sanitizer.add(s.value)
    const ws = await load(ctx)
    const onConflict = (args['onConflict'] as 'error' | 'merge' | 'replace' | undefined) ?? 'error'
    const ops: ProjectOp[] = []
    const conflicts: string[] = []
    for (const c of converted.connectors) {
      if (ws.connectors.has(c.id) && onConflict !== 'replace') {
        if (onConflict === 'error') conflicts.push(`conector "${c.id}"`)
        else for (const endpoint of c.endpoints ?? []) ops.push({ op: 'upsertEndpoint', connectorId: c.id, endpoint })
      } else ops.push({ op: 'upsertConnector', connector: c })
    }
    for (const env of converted.environments) {
      if (ws.environments.has(env.id) && onConflict === 'error') conflicts.push(`ambiente "${env.id}"`)
      ops.push({ op: 'upsertEnvironment', environment: env, ...(onConflict === 'replace' && { overwriteValues: true }) })
    }
    const summary = {
      sources: converted.sources,
      connectors: converted.connectors.map((c) => ({
        id: c.id,
        name: c.name,
        ...(c.extends && { extends: c.extends }),
        endpoints: c.endpoints?.length ?? 0
      })),
      environments: converted.environments.map((e) => e.id),
      ...(converted.secrets.length && {
        pendingSecrets: {
          variables: converted.secrets.map((s) => `${s.environmentId}/${s.variable}`),
          note: 'valores não gravados pela IA: o usuário preenche no app (Git › pendências) ou importa o ambiente do Postman pelo app'
        }
      }),
      ...(converted.warnings.length && { warnings: converted.warnings }),
      ...(converted.errors.length && { errors: converted.errors })
    }
    if (args['apply'] !== true) {
      return {
        ...summary,
        ...(conflicts.length && { conflicts, note: 'já existem no projeto: ajuste os ids ou use apply com onConflict merge/replace' }),
        ops
      }
    }
    writesBlocked(ctx)
    if (conflicts.length) {
      throw new ToolError(`já existem no projeto: ${conflicts.join(', ')}; use onConflict merge ou replace, ou rode sem apply e ajuste os ids`)
    }
    if (!ops.length) throw new ToolError('nada para importar')
    const result = await applyProjectOps(ctx.workspaceDir, ops, {
      actor: 'ai',
      dryRun: args['dryRun'] === true,
      checkText: (_path, content) => (ctx.sanitizer.leaks(content) ? 'contém o valor de uma credencial real' : undefined)
    })
    if (result.ok && !result.dryRun) ctx.auth.clear()
    return { ...summary, ...report(result, ops) }
  }
}

const exportProject: McpTool = {
  name: 'export_project',
  title: 'Exportar o projeto (pacote do VVPost, Postman, OpenAPI ou .vvpost.zip)',
  description:
    'Exporta o projeto ou uma seleção (connectors, endpoints "conector/endpoint", environments, flows). format: vvpost (pacote para import_bundle, padrão), postman (coleção v2.1 e ambientes) ou openapi (spec 3.1). Pais e conectores usados pelos fluxos vão junto. ' +
    'format: "zip" grava a pasta do projeto como está (com documento, diagramas, schemas e dados de teste) num .vvpost.zip dentro do projeto (out, padrão dist/<pasta>.vvpost.zip); scope: "workspace" leva o workspace inteiro. Nenhum segredo sai: a auth vai como {{VAR}}, e a exportação é recusada se algum vazaria.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      format: { type: 'string', enum: ['vvpost', 'postman', 'openapi', 'zip'], description: 'Padrão: vvpost.' },
      scope: { enum: ['project', 'workspace'], description: 'zip: a pasta do projeto (padrão) ou o workspace inteiro.' },
      out: { type: 'string', description: 'zip: caminho do arquivo dentro do projeto, terminado em .vvpost.zip.' },
      connectors: { type: 'array', items: { type: 'string' }, description: 'Ids de conectores (com todos os endpoints).' },
      endpoints: { type: 'array', items: { type: 'string' }, description: '"<conector>/<endpoint>": só estes endpoints do conector.' },
      environments: { type: 'array', items: { type: 'string' } },
      flows: { type: 'array', items: { type: 'string' } },
      scenarios: { type: 'boolean', description: 'false tira os cenários de teste. Padrão: true.' },
      docs: { type: 'boolean', description: 'false não leva a documentação Markdown. Padrão: true.' },
      name: { type: 'string' },
      description: { type: 'string' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  async call(args, ctx) {
    if (args['format'] === 'zip') return exportZip(args, ctx)
    await load(ctx)
    const selection = Object.fromEntries(
      (['format', 'connectors', 'endpoints', 'environments', 'flows', 'scenarios', 'docs'] as const)
        .filter((k) => args[k] !== undefined)
        .map((k) => [k, args[k]])
    ) as ExportSelection
    if (selection.format !== undefined && !['vvpost', 'postman', 'openapi'].includes(selection.format)) {
      throw new ToolError('format: use vvpost, postman, openapi ou zip')
    }
    try {
      const result = await exportAs(ctx.workspaceDir, selection, {
        ...(typeof args['name'] === 'string' && { name: args['name'] }),
        ...(typeof args['description'] === 'string' && { description: args['description'] }),
        generator: 'VVPost MCP'
      })
      const [main, ...extra] = result.files
      const payload =
        result.format === 'vvpost'
          ? { bundle: main.data }
          : result.format === 'postman'
            ? { collection: main.data, environments: extra.map((f) => f.data) }
            : { spec: main.data }
      return { format: result.format, summary: result.summary, ...(result.warnings.length && { warnings: result.warnings }), ...payload }
    } catch (err) {
      if (err instanceof ExportError) throw new ToolError(err.message)
      throw err
    }
  }
}

/** export_project { format: "zip" }: a pasta como está, como o vvpost export --format zip. */
async function exportZip(args: Record<string, unknown>, ctx: ToolContext) {
  writesBlocked(ctx)
  const filter = ['connectors', 'endpoints', 'environments', 'flows', 'scenarios', 'docs', 'description'].find((k) => args[k] !== undefined)
  if (filter) throw new ToolError(`format: "zip" leva a pasta inteira; ${filter} vale só para o pacote, o Postman e o OpenAPI`, { code: 'INVALID_ARGS' })
  const { exportArchive, ArchiveExportError, ARCHIVE_SUFFIX } = await import('../bundle/archive')
  let result
  try {
    result = await exportArchive(ctx.workspaceDir, args['scope'] === 'workspace' ? 'workspace' : 'project', {
      ...(typeof args['name'] === 'string' && args['name'].trim() && { name: args['name'].trim() }),
      generator: 'VVPost MCP'
    })
  } catch (err) {
    if (err instanceof ArchiveExportError) throw new ToolError(err.message, { code: err.leak ? 'BLOCKED' : 'VALIDATION' })
    throw err
  }
  const out = typeof args['out'] === 'string' && args['out'] ? args['out'] : `dist/${basename(result.folder)}${ARCHIVE_SUFFIX}`
  if (!out.toLowerCase().endsWith(ARCHIVE_SUFFIX)) throw new ToolError(`out precisa terminar em ${ARCHIVE_SUFFIX}`, { code: 'INVALID_ARGS' })
  let rel: string
  try {
    rel = safeRel(out)
  } catch (err) {
    throw new ToolError((err as Error).message, { code: 'INVALID_ARGS' })
  }
  const path = join(ctx.workspaceDir, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, result.data)
  return {
    ok: true,
    format: 'zip',
    file: rel.split(sep).join('/'),
    bytes: result.data.length,
    kind: result.manifest.kind,
    summary: result.summary,
    ...(result.warnings.length && { warnings: result.warnings })
  }
}

const generateDocs: McpTool = {
  name: 'generate_docs',
  title: 'Gerar a documentação rica',
  description:
    'A documentação rica em Markdown de um nível: sem argumentos o projeto (o documento do projeto montado, com diagnósticos; generated: true traz a referência gerada), com connector, endpoint e scenario o nível pedido. outline: true devolve só os títulos, quantos diagramas e o tamanho, para conferir sem gastar contexto. Segredos só pelo nome.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      generated: { type: 'boolean', description: 'No projeto: a referência gerada, mesmo com o documento do projeto.' },
      connector: { type: 'string', description: 'Id do conector.' },
      endpoint: { type: 'string', description: 'Id do endpoint (precisa de connector).' },
      scenario: { type: 'string', description: 'Id do cenário (precisa de connector e endpoint).' },
      outline: {
        type: 'boolean',
        description: 'Só a estrutura (títulos, diagramas, tamanho e diagnósticos), sem o Markdown: para conferir o documento sem gastar contexto.'
      }
    }
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async call(args, ctx) {
    const shape = (markdown: string) => (args['outline'] === true ? outlineOf(markdown) : { markdown })
    const text = (k: string) => (typeof args[k] === 'string' && args[k] ? (args[k] as string) : undefined)
    const [connector, endpoint, scenario] = [text('connector'), text('endpoint'), text('scenario')]
    if ((endpoint && !connector) || (scenario && !endpoint)) {
      throw new ToolError('endpoint precisa de connector, e scenario precisa de connector e endpoint')
    }
    const scope: DocScope = scenario
      ? { kind: 'request', connectorId: connector!, endpointId: endpoint!, scenarioId: scenario }
      : endpoint
        ? { kind: 'endpoint', connectorId: connector!, endpointId: endpoint }
        : connector
          ? { kind: 'connector', connectorId: connector }
          : { kind: 'project' }
    const ws = await load(ctx)
    const docs = await import('@vvpost/core/docs')
    try {
      const flows = await loadFlows(ctx.workspaceDir)
      const options = { projectName: basename(ctx.workspaceDir), generator: 'VVPost MCP' }
      if (scope.kind === 'project' && args['generated'] !== true) {
        const project = await docs.loadDocsProject(ctx.workspaceDir)
        if (project.source !== null) {
          const composed = await docs.composeDocumentation(ws, flows, {
            ...options,
            source: project.source,
            sourceFile: project.sourceFile,
            config: project.config
          })
          return {
            title: composed.title,
            scope: 'Documento do projeto',
            source: project.sourceFile,
            ...shape(composed.markdown),
            ...(composed.diagnostics.length && { diagnostics: composed.diagnostics }),
            ...(project.configIssues.length && { configIssues: project.configIssues })
          }
        }
      }
      const { document, markdown } = await docs.generateDocumentation(ws, flows, scope, options)
      return { title: document.title, scope: document.scopeLabel, ...shape(markdown) }
    } catch (err) {
      if (err instanceof docs.DocsError) throw new ToolError(err.message)
      throw err
    }
  }
}

/** A estrutura de um Markdown (títulos até o nível 4 e quantos diagramas), sem o texto. */
function outlineOf(markdown: string) {
  const headings: string[] = []
  let fenced = false
  let diagrams = 0
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (!fenced && /^\s*```mermaid/.test(line)) diagrams++
      fenced = !fenced
      continue
    }
    const m = !fenced && /^(#{1,4})\s+(.+?)\s*$/.exec(line)
    if (m) headings.push(`${'  '.repeat(m[1]!.length - 1)}${m[2]}`)
  }
  return { outline: headings, diagrams, chars: markdown.length }
}

/** Ocorrências devolvidas por find_references (o agente refina os termos se passar disto). */
const MAX_REFERENCES = 100

const findReferences: McpTool = {
  name: 'find_references',
  title: 'Onde um nome aparece no projeto',
  description:
    'Procura termos (um conector, um sistema, uma regra que saiu do código) em todo o projeto de uma vez: páginas e diagramas da documentação, documento do projeto, docs dos conectores e os campos dos fluxos e conectores (ids, nomes, descrições, URLs). ' +
    'Devolve arquivo, linha (ou caminho do campo) e o trecho, para corrigir com write_docs_page (edits) ou edit_project. Use antes de apagar ou renomear algo, e depois para conferir que nada ficou para trás. Não diferencia maiúsculas nem acentos. ' +
    'Só o projeto do VVPost: no código e no README do repositório, procure com grep. exact diz, por termo, em que arquivos a op replaceReferences trocaria o termo (palavra inteira, mesma caixa, chaves incluídas): escolha o in por ele e grave direto, sem dryRun.',
  inputSchema: {
    type: 'object',
    required: ['terms'],
    additionalProperties: false,
    properties: { terms: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 2 } } }
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async call(args, ctx) {
    const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    const terms = (args['terms'] as string[]).map(fold)
    const hit = (s: string) => terms.some((t) => fold(s).includes(t))
    const clip = (s: string) => {
      const folded = fold(s)
      const at = Math.max(0, Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0)) - 60)
      return `${at ? '…' : ''}${s.slice(at, at + 160).trim()}${s.length > at + 160 ? '…' : ''}`
    }
    const matches: { file: string; line?: number; field?: string; text: string }[] = []
    const docs = await import('@vvpost/core/docs')
    const files = await docs.listDocsFiles(ctx.workspaceDir)
    const texts = [...files.markdown.map((f) => f.file), ...files.diagrams].filter((f) => !f.startsWith('docs/export/'))
    for (const file of texts) {
      const text = await readFile(join(ctx.workspaceDir, file), 'utf8').catch(() => '')
      text.split(/\r?\n/).forEach((line, i) => {
        if (hit(line)) matches.push({ file, line: i + 1, text: clip(line) })
      })
    }
    // Nos fluxos e conectores, os textos de cada campo, com o caminho do campo.
    const ws = await load(ctx)
    const walk = (file: string, value: unknown, path: string) => {
      if (typeof value === 'string') {
        if (hit(value)) matches.push({ file, field: path || '/', text: clip(value) })
      } else if (Array.isArray(value)) value.forEach((v, i) => walk(file, v, `${path}[${i}]`))
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(file, v, path ? `${path}.${k}` : k)
    }
    for (const { file, flow } of (await loadFlows(ctx.workspaceDir)).flows) walk(file, flow, '')
    for (const shared of ws.schemas?.values() ?? []) if (!shared.shared) walk(shared.file, shared.schema, '')
    for (const [id, file] of ws.connectorFiles) {
      if (ws.flowSources?.get(id) === file || file.startsWith('project:') || file.startsWith('..')) continue
      walk(file, ws.connectors.get(id), '')
    }
    // O que replaceReferences trocaria, termo a termo: com isso o agente escolhe o in sem um dryRun.
    const exact: Record<string, { count: number; files: { file: string; count: number }[] }> = {}
    for (const term of args['terms'] as string[]) {
      const scan: ReplaceScan = { count: 0, changes: [], nearMisses: [], skipped: [] }
      await planReplace(ctx, term, `${term}\u0000`, undefined, scan)
      if (!scan.count) continue
      const perFile = new Map<string, number>()
      for (const c of scan.changes) perFile.set(c.file, (perFile.get(c.file) ?? 0) + 1)
      exact[term] = { count: scan.count, files: [...perFile].map(([file, count]) => ({ file, count })) }
    }
    return {
      count: matches.length,
      ...(matches.length > MAX_REFERENCES && { note: `mostrando ${MAX_REFERENCES} de ${matches.length}: use termos mais específicos` }),
      ...(Object.keys(exact).length && { exact }),
      matches: matches.slice(0, MAX_REFERENCES)
    }
  }
}

/** Trocas mostradas no dryRun de replace_references e quase-acertos devolvidos (o resto só conta). */
const MAX_REPLACE_SHOWN = 30

/** O termo como palavra inteira, com a mesma caixa: "cep" não pega "cepDestino" nem "CEP". */
function wordPattern(term: string): RegExp {
  const word = '[\\p{L}\\p{N}_]'
  return new RegExp(`(?<!${word})${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!${word})`, 'gu')
}

const foldText = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

interface ReplaceScan {
  count: number
  /** Onde trocou: linha de uma página ou caminho de um campo, com o texto novo. */
  changes: { file: string; line?: number; field?: string; text: string }[]
  /** Onde o termo aparece com outra caixa, acento ou dentro de outra palavra, e ficou como estava. */
  nearMisses: { file: string; line?: number; field?: string; text: string }[]
  /** O que o termo alcança e a troca não muda (ids, arquivos fora do alcance). */
  skipped: { file: string; field?: string; reason: string }[]
}

/**
 * O documento com o termo trocado: chaves iguais ao termo (o campo de um schema, de um exemplo)
 * e o termo como palavra em cada texto. O id de um conector, endpoint ou fluxo não muda: renomear
 * um id é moveConnector ou moveEndpoint, que levam junto quem aponta para ele.
 */
function replaceInJson(file: string, value: unknown, path: string, from: string, to: string, scan: ReplaceScan): unknown {
  const re = wordPattern(from)
  const folded = foldText(from)
  const visit = (v: unknown, p: string): unknown => {
    if (typeof v === 'string') {
      const n = v.match(re)?.length ?? 0
      if (!n) {
        if (foldText(v).includes(folded)) scan.nearMisses.push({ file, field: p || '/', text: v.slice(0, 160) })
        return v
      }
      if (/^(?:(?:nodes|endpoints)\[\d+\]\.)?id$/.test(p)) {
        scan.skipped.push({ file, field: p, reason: 'id não muda por troca de texto: use moveConnector ou moveEndpoint no edit_project' })
        return v
      }
      const next = v.replace(re, () => to)
      scan.count += n
      scan.changes.push({ file, field: p || '/', text: next.slice(0, 160) })
      return next
    }
    if (Array.isArray(v)) return v.map((x, i) => visit(x, `${p}[${i}]`))
    if (!v || typeof v !== 'object') return v
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const renamed = k === from && !(to in (v as Record<string, unknown>))
      if (renamed) {
        scan.count++
        scan.changes.push({ file, field: p ? `${p}.${to}` : to, text: `chave ${from} → ${to}` })
      } else if (k === from) scan.skipped.push({ file, field: p ? `${p}.${k}` : k, reason: `já existe a chave ${to} ao lado` })
      out[renamed ? to : k] = visit(x, p ? `${p}.${renamed ? to : k}` : renamed ? to : k)
    }
    return out
  }
  return visit(value, path)
}

/** O texto com o termo trocado, linha a linha. */
function replaceInText(file: string, text: string, from: string, to: string, scan: ReplaceScan): string {
  const re = wordPattern(from)
  const folded = foldText(from)
  return text
    .split('\n')
    .map((line, i) => {
      const n = line.match(re)?.length ?? 0
      if (!n) {
        if (foldText(line).includes(folded)) scan.nearMisses.push({ file, line: i + 1, text: line.trim().slice(0, 160) })
        return line
      }
      const next = line.replace(re, () => to)
      scan.count += n
      scan.changes.push({ file, line: i + 1, text: next.trim().slice(0, 160) })
      return next
    })
    .join('\n')
}

/**
 * As trocas de replace_references, sem gravar: as ops do catálogo (fluxos, schemas, conectores,
 * docs de conector) e as páginas de docs/ com o texto novo. pageText dá o texto atual de uma
 * página quando um lote já a mudou antes.
 */
async function planReplace(
  ctx: ToolContext,
  from: string,
  to: string,
  scope: string[] | undefined,
  scan: ReplaceScan,
  pageText: (file: string) => Promise<string | null> = (file) => readFile(join(ctx.workspaceDir, file), 'utf8').catch(() => null),
  prior?: Map<string, ProjectOp>
) {
  const ws = await load(ctx)
  const roles = new Map<string, string>()
  for (const [key, file] of ws.flowSources ?? []) roles.set(file, key.split('/')[0]!)
  const inScope = (file: string, connector?: string) =>
    !scope || scope.some((s) => s === connector || s === file || file.startsWith(s.endsWith('/') ? s : `${s}/`))
  // Num lote com várias trocas, cada uma parte do que a anterior já trocou.
  const earlier = <T>(op: ProjectOp | undefined, pick: (op: never) => T, value: T): T => (op ? pick(op as never) : value)

  const ops: ProjectOp[] = []
  for (const { file, flow: onDisk } of (await loadFlows(ctx.workspaceDir)).flows) {
    if (!inScope(file, roles.get(file) ?? onDisk.id)) continue
    const flow = earlier(prior?.get(replaceKey({ op: 'upsertFlow', flow: onDisk, file })), (op: { flow: typeof onDisk }) => op.flow, onDisk)
    const before = scan.count
    const next = replaceInJson(file, flow, '', from, to, scan) as typeof flow
    if (scan.count > before) ops.push({ op: 'upsertFlow', flow: next, file })
  }
  // Os schemas compartilhados (schemas/<Nome>.schema.json): o campo citado por vários endpoints mora
  // aqui. Com in, entram os que um conector do alcance cita, direto ou por outro schema.
  const cited = new Set<string>()
  const cite = (doc: unknown) => {
    for (const m of JSON.stringify(doc ?? null).matchAll(/"schema:([^"#]+)"/g)) {
      if (cited.has(m[1]!)) continue
      cited.add(m[1]!)
      cite(ws.schemas?.get(m[1]!)?.schema)
    }
  }
  if (scope) {
    for (const { file, flow } of (await loadFlows(ctx.workspaceDir)).flows) if (inScope(file, roles.get(file) ?? flow.id)) cite(flow)
    for (const [id, file] of ws.connectorFiles) if (inScope(file, id)) cite(ws.connectors.get(id))
  }
  for (const shared of ws.schemas?.values() ?? []) {
    if (shared.shared || !(inScope(shared.file, `schema:${shared.name}`) || cited.has(shared.name))) continue
    const schema = earlier(prior?.get(`schema:${shared.name}`), (op: { schema: Record<string, unknown> }) => op.schema, shared.schema)
    const before = scan.count
    const next = replaceInJson(shared.file, schema, '', from, to, scan) as Record<string, unknown>
    if (scan.count > before) ops.push({ op: 'upsertSchema', name: shared.name, schema: next })
  }
  const docsOf = new Map<string, string>()
  for (const [id, file] of ws.connectorFiles) {
    if (file.startsWith('project:') || file.startsWith('..') || isAbsolute(file)) continue
    docsOf.set(docsFileOf(file), id)
    if (ws.flowSources?.get(id) === file || !inScope(file, id)) continue
    const connector = earlier(prior?.get(`connector:${id}`), (op: { connector: Connector }) => op.connector, ws.connectors.get(id))
    const before = scan.count
    const next = replaceInJson(file, connector, '', from, to, scan) as Connector
    if (scan.count > before) ops.push({ op: 'upsertConnector', connector: next, file })
  }
  const docs = await import('@vvpost/core/docs')
  const listed = await docs.listDocsFiles(ctx.workspaceDir)
  const pages: { file: string; before: string; after: string }[] = []
  for (const file of [...listed.markdown.map((f) => f.file), ...listed.diagrams]) {
    if (file.startsWith('docs/export/')) continue
    const connector = docsOf.get(file)
    if (!inScope(file, connector)) continue
    const before = connector
      ? earlier(prior?.get(`doc:${connector}`), (op: { markdown: string }) => op.markdown, await pageText(file))
      : await pageText(file)
    if (before === null) continue
    const count = scan.count
    const after = replaceInText(file, before, from, to, scan)
    if (scan.count === count) continue
    if (connector) ops.push({ op: 'writeDoc', connectorId: connector, markdown: after })
    else if (file.startsWith('docs/')) pages.push({ file, before, after })
    else {
      scan.count = count
      scan.changes = scan.changes.filter((c) => c.file !== file)
      scan.skipped.push({ file, reason: 'fora de docs/ e sem conector: o VVPost não grava este arquivo' })
    }
  }
  return { ops, pages }
}

/** O alvo de uma op de planReplace: a troca seguinte no mesmo lote substitui a op do mesmo alvo. */
function replaceKey(op: ProjectOp): string {
  switch (op.op) {
    case 'upsertFlow':
      return `flow:${op.file ?? op.flow.id}`
    case 'upsertSchema':
      return `schema:${op.name}`
    case 'upsertConnector':
      return `connector:${op.connector.id}`
    case 'writeDoc':
      return `doc:${op.connectorId}`
    default:
      return `${op.op}:${JSON.stringify(op)}`
  }
}

const replaceReferences: McpTool = {
  name: 'replace_references',
  title: 'Trocar um nome em todo o projeto',
  description:
    'Troca um nome (um campo renomeado, um sistema que mudou de nome) em todo o projeto num lote só, tudo ou nada: chaves e textos dos fluxos e conectores (schemas, exemplos, required, descrições, URLs), páginas e diagramas em docs/ e docs dos conectores. ' +
    'Palavra inteira e com a mesma caixa ("cep" não pega "cepDestino" nem "CEP"); o que só parece o termo volta em nearMisses, sem trocar. Ids não mudam (moveConnector, moveEndpoint). ' +
    'Schemas compartilhados (schemas/) entram junto. in limita a conectores (id), schemas (schema:<Nome>) ou arquivos (caminho ou pasta, como docs/guia.md, schemas/ ou docs/). Valida como o edit_project; dryRun mostra as trocas sem gravar.',
  inputSchema: {
    type: 'object',
    required: ['from', 'to'],
    additionalProperties: false,
    properties: {
      from: { type: 'string', minLength: 2 },
      to: { type: 'string' },
      in: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: 'Só nestes conectores (id), schemas (schema:<Nome>) ou arquivos e pastas.' },
      dryRun: { type: 'boolean' },
      expect: expectSchema
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    writesBlocked(ctx)
    const from = String(unquote(args['from']))
    const to = String(unquote(args['to']))
    if (from === to) throw new ToolError('from e to são iguais', { code: 'INVALID_ARGS' })
    await assertExpected(ctx, args['expect'])
    const scope = Array.isArray(args['in']) ? (args['in'] as string[]) : undefined
    const ws = await load(ctx)
    const scan: ReplaceScan = { count: 0, changes: [], nearMisses: [], skipped: [] }
    const { ops, pages } = await planReplace(ctx, from, to, scope, scan)
    const docs = await import('@vvpost/core/docs')
    const shown = {
      ...(scan.nearMisses.length && { nearMisses: scan.nearMisses.slice(0, MAX_REPLACE_SHOWN) }),
      ...(scan.skipped.length && { skipped: scan.skipped.slice(0, MAX_REPLACE_SHOWN) })
    }
    const files = [...new Set(scan.changes.map((c) => c.file))].map((file) => ({ file, count: scan.changes.filter((c) => c.file === file).length }))
    if (!scan.count) return { ok: true, replaced: 0, note: `"${from}" não aparece como palavra inteira no alcance`, hint: REPLACE_SCOPE_HINT, ...shown }

    const leak = pages.find((p) => ctx.sanitizer.leaks(p.after))
    if (leak) throw new ToolError(`${leak.file} ficaria com o valor de uma credencial; nada foi gravado`, { code: 'VALIDATION' })
    const options = {
      actor: 'ai' as const,
      checkText: (_path: string, content: string) =>
        ctx.sanitizer.leaks(content) ? 'contém o valor de uma credencial real; use uma variável {{NOME}} marcada como segredo' : undefined
    }
    const checked = ops.length ? await applyProjectOps(ctx.workspaceDir, ops, { ...options, dryRun: true }) : undefined
    if (checked && !checked.ok) return { ...report(checked, ops), ...shown }
    if (args['dryRun'] === true) {
      return { ok: true, dryRun: true, replaced: scan.count, files, changes: scan.changes.slice(0, MAX_REPLACE_SHOWN), ...shown, note: 'nada foi gravado; mande sem dryRun para aplicar' }
    }

    // Páginas primeiro, guardando o texto de antes; se o lote do catálogo falhar, elas voltam.
    const written: { file: string; before: string }[] = []
    const undo = async () => {
      for (const p of written.reverse()) await writeFile(join(ctx.workspaceDir, p.file), p.before).catch(() => {})
    }
    try {
      for (const p of pages) {
        await docs.writeDocsPage(ws, p.file, p.after)
        written.push(p)
      }
    } catch (err) {
      await undo()
      if (err instanceof docs.DocsError) throw new ToolError(`${err.message}; nada foi gravado`, { code: 'VALIDATION' })
      throw err
    }
    let applied: ProjectApplyResult | undefined
    if (ops.length) {
      applied = await applyProjectOps(ctx.workspaceDir, ops, options)
      if (!applied.ok || applied.conflicts?.length) {
        await undo()
        return { ...report(applied, ops), ...shown }
      }
      ctx.auth.clear()
    }
    return {
      ok: true,
      replaced: scan.count,
      files,
      ...shown,
      ...(applied?.review.length && { review: reviewReport(applied.review) }),
      catalog: await catalogCheck(ctx),
      ...(await afterWrite(ctx))
    }
  }
}

const exportDocs: McpTool = {
  name: 'export_docs',
  title: 'Exportar a documentação em PDF, Markdown ou site HTML',
  description:
    'Grava a documentação do projeto num arquivo, como o "Exportar PDF" do app: o documento do projeto montado (com a capa, o logo, as cores, o cabeçalho e o rodapé do modelo vvpost.docs.json e os diagramas Mermaid desenhados), ou a referência gerada (generated: true). ' +
    'Devolve só o caminho, o tamanho e as páginas, sem o conteúdo. Para o mesmo padrão em vários projetos, use o mesmo modelo (save_docs_template / template) em cada um. ' +
    'format: "site" grava o site HTML estático (como o vvpost docs export: o destino html do vvpost.publish.json, ou dist/site com a estrutura de partida), com a página Mudanças; label nomeia a versão. ' +
    'Nenhum valor de segredo entra; o arquivo fica dentro do projeto (padrão docs/export/<projeto>.pdf).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      format: { enum: ['pdf', 'md', 'site'], description: 'pdf (padrão), md ou site.' },
      out: { type: 'string', description: 'Caminho do arquivo dentro do projeto, terminado em .pdf ou .md; com site, a pasta.' },
      generated: { type: 'boolean', description: 'A referência gerada em vez do documento do projeto (pdf e md).' },
      target: { type: 'string', description: 'site: o id do destino no vvpost.publish.json, quando há mais de um.' },
      label: { type: 'string', maxLength: 80, description: 'site: nome desta versão na página Mudanças (ex.: v2.3.0).' },
      force: { type: 'boolean', description: 'site: sobrescreve páginas editadas à mão na pasta desde a última exportação; só se a pessoa pediu.' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    writesBlocked(ctx)
    if (args['format'] === 'site') return exportSite(args, ctx)
    const format = args['format'] === 'md' ? 'md' : 'pdf'
    const name = basename(ctx.workspaceDir)
    const out = typeof args['out'] === 'string' && args['out'] ? args['out'] : `docs/export/${name}.${format}`
    if (!out.toLowerCase().endsWith(`.${format}`)) throw new ToolError(`out precisa terminar em .${format}`, { code: 'INVALID_ARGS' })
    let rel: string
    try {
      rel = safeRel(out)
    } catch (err) {
      throw new ToolError((err as Error).message, { code: 'INVALID_ARGS' })
    }
    const ws = await load(ctx)
    const docs = await import('@vvpost/core/docs')
    const flows = await loadFlows(ctx.workspaceDir)
    const project = await docs.loadDocsProject(ctx.workspaceDir)
    const options = { projectName: name, generator: 'VVPost MCP' }
    const useProject = project.source !== null && args['generated'] !== true
    let title: string
    let markdown: string
    let printMarkdown: string
    let diagnostics: unknown[] = []
    try {
      if (useProject) {
        const composed = await docs.composeDocumentation(ws, flows, { ...options, source: project.source!, sourceFile: project.sourceFile, config: project.config })
        ;({ title, markdown, printMarkdown } = composed)
        diagnostics = composed.diagnostics
      } else {
        const generated = await docs.generateDocumentation(ws, flows, { kind: 'project' }, options)
        title = generated.document.title
        markdown = printMarkdown = generated.markdown
      }
    } catch (err) {
      if (err instanceof docs.DocsError) throw new ToolError(err.message, { code: 'VALIDATION' })
      throw err
    }
    if (ctx.sanitizer.leaks(markdown) || ctx.sanitizer.leaks(printMarkdown)) {
      throw new ToolError('o documento teria o valor de uma credencial; nada foi gravado', { code: 'BLOCKED' })
    }
    const path = join(ctx.workspaceDir, rel)
    await mkdir(dirname(path), { recursive: true })
    let logo = false
    if (format === 'md') await writeFile(path, markdown)
    else {
      const { printLayout } = await import('@vvpost/core/docs/theme')
      let logoUrl: string | undefined
      if (project.config.logo) logoUrl = await docs.readDocsLogo(ctx.workspaceDir, project.config.logo).catch(() => undefined)
      logo = !!logoUrl
      const layout = printLayout(
        project.config,
        { title, project: name, date: new Date().toLocaleDateString('pt-BR'), ...(logoUrl && { logo: logoUrl }) },
        { cover: useProject && project.config.cover !== false }
      )
      const { printInSubprocess } = await import('../docs/print-spawn')
      try {
        await printInSubprocess({ title, markdown: printMarkdown, layout, out: path })
      } catch (err) {
        throw new ToolError(`o PDF não foi gerado: ${(err as Error).message}`, {
          code: 'PRINT_FAILED',
          hint: 'nesta máquina o PDF não sai (precisa do Electron com tela); a documentação já está gravada no projeto, então diga isso à pessoa em vez de exportar o Markdown no lugar. format: "md" só se ela pediu o .md'
        })
      }
    }
    const bytes = await readFile(path)
    const errors = (diagnostics as { severity?: string }[]).filter((d) => d.severity === 'error').length
    return {
      ok: true,
      file: rel.split(sep).join('/'),
      format,
      title,
      bytes: bytes.length,
      ...(format === 'pdf' && { pages: (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length, logo }),
      source: useProject ? project.sourceFile : 'referência gerada',
      ...(errors && { diagnostics: errors, hint: 'há diretivas com erro no documento: get_docs_project mostra onde' })
    }
  }
}

/**
 * export_docs { format: "site" }: o site HTML do vvpost docs export, numa pasta dentro do
 * projeto. Só o exportador html: o MCP não carrega plugins (o destino de um exportador de plugin
 * sai pelo CLI), e os publicadores remotos ficam no app, com confirmação.
 */
async function exportSite(args: Record<string, unknown>, ctx: ToolContext) {
  const text = (k: string) => (typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string).trim() : undefined)
  const [exp, site, docs] = await Promise.all([import('@vvpost/core/docs/export'), import('../docs/site-export'), import('@vvpost/core/docs')])
  const out = text('out')
  try {
    const folder = out ? await exp.workspaceExportFolder(ctx.workspaceDir, out) : undefined
    const { target, folder: written, result, diagnostics, warnings } = await site.exportDocsSite(ctx.workspaceDir, {
      exporters: [exp.htmlExporter],
      generator: 'VVPost MCP',
      target: text('target'),
      folder,
      label: text('label'),
      force: args['force'] === true,
      targetOption: 'target',
      remoteHint: 'esse destino sai pelo app (Documentação → Enviar para…) ou, se for de um exportador de plugin, por vvpost docs export'
    })
    const errors = diagnostics.filter((d) => d.severity === 'error').length
    const all = [...warnings, ...result.plan.warnings]
    return {
      ok: true,
      format: 'site',
      target: target.id,
      dir: written.label,
      ...site.siteTally(result),
      ...(all.length && { warnings: all }),
      ...(errors && { diagnostics: errors, hint: 'há diretivas com erro no documento: get_docs_project mostra onde' })
    }
  } catch (err) {
    const message = (err as Error).message
    if (/editadas à mão/.test(message)) {
      throw new ToolError(message.replace('use --force', 'force: true'), { code: 'CONFLICT', hint: 'alguém editou o site exportado; só sobrescreva com force: true se a pessoa pedir' })
    }
    if (err instanceof site.SiteConfigError || err instanceof docs.DocsError) throw new ToolError(message, { code: 'VALIDATION' })
    throw err
  }
}

/** Diagnósticos e título do documento do projeto montado, para a IA conferir o que escreveu. */
async function compileProjectDocs(ctx: ToolContext, config: unknown, source: string) {
  const docs = await import('@vvpost/core/docs')
  const ws = await load(ctx)
  const parsed = docs.parseDocsConfig(config)
  const composed = await docs.composeDocumentation(ws, await loadFlows(ctx.workspaceDir), {
    projectName: basename(ctx.workspaceDir),
    generator: 'VVPost MCP',
    source,
    sourceFile: docs.normalizeRel(parsed.source ?? docs.DEFAULT_DOCS_SOURCE),
    config: parsed
  })
  return { ws, docs, config: parsed, composed }
}

const getDocsProject: McpTool = {
  name: 'get_docs_project',
  title: 'Ler o documento do projeto',
  description:
    'O documento do projeto: o modelo vvpost.docs.json, o Markdown-fonte, as diretivas {{> ...}} (summary, map, connector <id>, endpoint <c>/<e>, include <arquivo.md>#<seção>...), as páginas em docs/ com seções e versão, as imagens, os modelos (builtin:c4, arc42, diataxis, adr e os do projeto) e os diagnósticos por linha. Sem documento, source vem null e starter traz um começo.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { offset: { type: 'integer', minimum: 0, description: 'De que caractere continuar o source longo (o sourceTruncated.next.offset da resposta anterior).' } }
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async call(args, ctx) {
    const docs = await import('@vvpost/core/docs')
    const [project, files, templates] = await Promise.all([
      docs.loadDocsProject(ctx.workspaceDir),
      docs.listDocsFiles(ctx.workspaceDir),
      docs.listDocTemplates(ctx.workspaceDir)
    ])
    const compiled = project.source === null ? null : await compileProjectDocs(ctx, project.config, project.source).catch((err: Error) => err)
    return {
      configFile: docs.DOCS_CONFIG_FILE,
      versions: await fileVersions(ctx.workspaceDir, [docs.DOCS_CONFIG_FILE, project.sourceFile]),
      configExists: project.configExists,
      config: project.config,
      ...(project.configIssues.length && { configIssues: project.configIssues }),
      sourceFile: project.sourceFile,
      ...(project.source === null
        ? { source: null }
        : (({ text, truncated }) => ({ source: text, ...(truncated && { sourceTruncated: truncated }) }))(sliceText(project.source, Number(args['offset'] ?? 0)))),
      ...(project.source === null && { starter: docs.DOCS_STARTER_SOURCE }),
      directives: docs.DOC_DIRECTIVES,
      // As páginas em docs/ com a versão, para editar com write_docs_page { edits, expect } sem reler o texto.
      markdownFiles: await withPageVersions(ctx, files.markdown),
      images: files.images,
      diagrams: files.diagrams,
      templates: templates.templates.map((t) => ({ id: t.id, name: t.name, description: t.description, origin: t.origin })),
      ...(templates.issues.length && { templateIssues: templates.issues }),
      ...(compiled instanceof Error
        ? { compileError: compiled.message }
        : compiled && { title: compiled.composed.title, diagnostics: compiled.composed.diagnostics })
    }
  }
}

const saveDocsProject: McpTool = {
  name: 'save_docs_project',
  title: 'Escrever o documento do projeto',
  description:
    'Grava o documento do projeto: config (o vvpost.docs.json inteiro) e/ou source (o Markdown inteiro); o que não vier fica. template (ex.: builtin:c4) começa de um modelo mantendo título, logo e arquivo. Monta antes e devolve os diagnósticos; dryRun só monta. Recusa schema inválido, caminho fora e valor de segredo.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      config: { type: 'object', description: 'Modelo vvpost.docs.json inteiro (substitui o atual).' },
      source: { type: 'string', description: 'Documento-fonte em Markdown inteiro (substitui o atual).' },
      template: { type: 'string', description: 'Modelo de documentação para começar (builtin:c4, builtin:arc42, builtin:diataxis, builtin:adr, builtin:api-guide ou project:<arquivo>).' },
      dryRun: { type: 'boolean', description: 'Só monta e devolve os diagnósticos, sem gravar.' },
      expect: expectSchema
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    if (args['config'] === undefined && args['source'] === undefined && args['template'] === undefined) {
      throw new ToolError('mande config, source, template ou uma combinação', { code: 'INVALID_ARGS' })
    }
    if (args['source'] !== undefined && typeof args['source'] !== 'string') throw new ToolError('source precisa ser texto')
    const docs = await import('@vvpost/core/docs')
    const project = await docs.loadDocsProject(ctx.workspaceDir)
    let base = { config: project.config as unknown, source: project.source ?? docs.DOCS_STARTER_SOURCE }
    if (typeof args['template'] === 'string') {
      const { templates } = await docs.listDocTemplates(ctx.workspaceDir)
      const template = templates.find((t) => t.id === args['template'] || t.id === `builtin:${String(args['template'])}`)
      if (!template) throw new ToolError(`modelo "${String(args['template'])}" não existe; veja templates em get_docs_project`)
      base = docs.applyDocTemplate(template, project.config)
    }
    const config = args['config'] ?? base.config
    const source = (args['source'] as string | undefined) ?? base.source
    try {
      const { ws, composed } = await compileProjectDocs(ctx, config, source)
      const errors = composed.diagnostics.filter((d) => d.severity === 'error').length
      if (args['dryRun'] === true) return { dryRun: true, title: composed.title, diagnostics: composed.diagnostics, note: 'nada foi gravado' }
      writesBlocked(ctx)
      await assertExpected(ctx, args['expect'])
      const { files } = await docs.writeDocsProject(ws, { config, source })
      return {
        ok: true,
        files,
        versions: await fileVersions(ctx.workspaceDir, files),
        title: composed.title,
        diagnostics: composed.diagnostics,
        ...(errors && { note: `${errors} diretiva(s) com erro aparecem como aviso no documento; corrija e grave de novo` })
      }
    } catch (err) {
      if (err instanceof docs.DocsError) throw new ToolError(err.message)
      throw err
    }
  }
}

const EDITS_SCHEMA = {
  type: 'array',
  minItems: 1,
  description: 'Troca trechos da página atual em vez de reenviar o texto inteiro: cada find aparece exatamente uma vez.',
  items: {
    type: 'object',
    required: ['find', 'replace'],
    additionalProperties: false,
    properties: { find: { type: 'string', minLength: 1 }, replace: { type: 'string' } }
  }
}

class EditMismatch extends Error {}

/** Aplica as trocas em ordem; cada trecho tem de existir uma vez só, para não trocar o lugar errado. */
function applyEdits(file: string, text: string | null, edits: { find: string; replace: string }[]): string {
  if (text === null) throw new EditMismatch(`"${file}" não existe; para criar, mande markdown`)
  // O agente manda \n; a página pode estar com \r\n (Windows). Compara sem o \r e grava no fim de
  // linha que o arquivo já usava.
  const crlf = text.includes('\r\n')
  const lf = (s: string) => s.replace(/\r\n/g, '\n')
  let out = lf(text)
  edits.forEach(({ find, replace }, i) => {
    const target = lf(find)
    const first = out.indexOf(target)
    const count = first < 0 ? 0 : out.indexOf(target, first + target.length) < 0 ? 1 : 2
    if (count !== 1) throw new EditMismatch(`edits[${i}]: o trecho ${count ? 'aparece mais de uma vez' : 'não está'} em "${file}"`)
    out = out.slice(0, first) + lf(replace) + out.slice(first + target.length)
  })
  return crlf ? out.replace(/\n/g, '\r\n') : out
}

const writeDocsPage: McpTool = {
  name: 'write_docs_page',
  title: 'Escrever uma página da documentação',
  description:
    'Grava páginas em docs/ (.md, incluídas no documento com {{> include docs/pagina.md}}) ou diagramas .mmd em docs/diagramas/ ({{> diagram ...}}; ícones vv:servidor, vv:banco, vv:api...). markdown troca a página inteira ("" apaga), edits troca trechos sem reenviar o resto (não precisa ler a página nem mandar expect: o find já confere o texto atual), pages grava várias tudo ou nada. Recusa caminho fora de docs/ e valor de segredo.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      file: { type: 'string', description: 'Caminho da página, em docs/ e terminado em .md, ou um diagrama Mermaid .mmd (ex.: docs/diagramas/contexto.mmd).' },
      markdown: { type: 'string', description: 'Conteúdo inteiro da página ("" apaga).' },
      pages: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_DOC_PAGES,
        description: 'Várias páginas numa chamada, no lugar de file e markdown: tudo ou nada (com um erro, as já gravadas voltam ao que eram).',
        items: {
          type: 'object',
          required: ['file'],
          additionalProperties: false,
          properties: { file: { type: 'string' }, markdown: { type: 'string' }, edits: EDITS_SCHEMA }
        }
      },
      edits: EDITS_SCHEMA,
      expect: expectSchema
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    writesBlocked(ctx)
    type Page = { file: string; markdown?: string; edits?: { find: string; replace: string }[] }
    const pages: Page[] | null = Array.isArray(args['pages'])
      ? (args['pages'] as Page[])
      : typeof args['file'] === 'string'
        ? [{ file: args['file'], markdown: args['markdown'] as string | undefined, edits: args['edits'] as Page['edits'] }]
        : null
    if (!pages || pages.some((p) => (p.markdown === undefined) === (p.edits === undefined))) {
      throw new ToolError('cada página leva markdown (o texto inteiro) ou edits (trechos a trocar), um dos dois', { code: 'INVALID_ARGS' })
    }
    await assertExpected(ctx, args['expect'])
    const docs = await import('@vvpost/core/docs')
    const ws = await load(ctx)
    // Tudo ou nada: guarda o texto de antes de cada página e devolve se uma falhar.
    const done: { path: string; before: string | null }[] = []
    const results: { file: string; deleted: boolean; changed: boolean }[] = []
    try {
      for (const page of pages) {
        const path = join(ctx.workspaceDir, docs.normalizeRel(page.file))
        const before = await readFile(path, 'utf8').catch(() => null)
        const markdown = page.edits ? applyEdits(page.file, before, page.edits) : page.markdown!
        const after = markdown === '' ? null : markdown.endsWith('\n') ? markdown : `${markdown}\n`
        const result = await docs.writeDocsPage(ws, page.file, markdown)
        done.push({ path, before })
        results.push({ ...result, changed: before !== after })
      }
    } catch (err) {
      for (const { path, before } of done.reverse()) {
        await (before === null ? rm(path, { force: true }) : writeFile(path, before)).catch(() => {})
      }
      const at = results.length < pages.length ? ` em pages[${results.length}] (${pages[results.length]!.file})` : ''
      if (err instanceof docs.DocsError || err instanceof EditMismatch) {
        throw new ToolError(`${err.message}${at}; nada foi gravado`, {
          code: 'VALIDATION',
          ...(err instanceof EditMismatch && { hint: 'find precisa aparecer exatamente uma vez no texto atual da página (leia em get_docs_project ou mande o markdown inteiro)' })
        })
      }
      throw err
    }
    const project = await docs.loadDocsProject(ctx.workspaceDir)
    const missing = results.filter((r) => !r.deleted && !r.file.endsWith('.mmd') && !(project.source?.includes(`{{> include ${r.file}`) ?? false))
    const versions = await fileVersions(ctx.workspaceDir, results.map((r) => r.file))
    const written = results.map((r) => ({ file: r.file, ...(r.deleted && { deleted: true }), ...(!r.changed && { unchanged: true }), version: versions[r.file] }))
    const note = missing.length
      ? `a página ainda não está no documento do projeto: inclua ${missing.map((r) => `{{> include ${r.file}}}`).join(', ')} no source (save_docs_project)`
      : undefined
    // O documento do projeto já montado com a página nova: o agente não precisa de outro generate_docs.
    const check = project.source === null ? null : await compileProjectDocs(ctx, project.config, project.source).catch(() => null)
    const diagnostics = check?.composed.diagnostics ?? []
    const docsCheck = check && {
      ...outlineOf(check.composed.markdown),
      outline: undefined,
      errors: diagnostics.filter((d) => d.severity === 'error').length,
      warnings: diagnostics.filter((d) => d.severity !== 'error').length,
      ...(diagnostics.length && { firstDiagnostics: diagnostics.slice(0, 3) })
    }
    return { ok: true, ...(Array.isArray(args['pages']) ? { pages: written } : written[0]), ...(note && { note }), ...(docsCheck && { document: docsCheck }), ...(await afterWrite(ctx, false)) }
  }
}

const fixDiagrams: McpTool = {
  name: 'fix_diagrams',
  title: 'Corrigir os diagramas de arquitetura que divergem do catálogo',
  description:
    'Corrige nos diagramas de arquitetura de docs/ (C4 e os fluxogramas e architecture-beta com %% vvpost:) o que o lint acusa e o VVPost sabe fazer: ' +
    'acrescenta o elemento e o %% vvpost:bind do conector (ou fluxo) que não aparece, a relação que um fluxo faz e o diagrama não mostra, e tira o elemento (com as relações) ' +
    'ligado a algo que não existe mais, a relação que o fluxo não faz mais e a anotação que sobrou. Sem apply, devolve o plano (linhas a tirar e a acrescentar por arquivo). ' +
    'Revise o texto em volta (rótulos, descrições) depois: a correção é só estrutural.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      apply: { type: 'boolean', description: 'true grava; sem ele, só o plano.' },
      codes: { type: 'array', items: { type: 'string' }, description: 'Só estas regras (c4-connector-missing, c4-binding-unknown, c4-relation-missing, c4-relation-stale, c4-flow-missing).' },
      file: { type: 'string', description: 'Só este arquivo (docs/...).' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    const apply = args['apply'] === true
    if (apply) writesBlocked(ctx)
    const ws = await load(ctx)
    const { drift } = await (await import('../lint')).lintWorkspace(ctx.workspaceDir, { ws, noHistory: true })
    let plan
    try {
      plan = await (await import('../lint/architecture')).fixDiagrams(ctx.workspaceDir, drift, {
        apply,
        ws,
        ...(Array.isArray(args['codes']) && { codes: args['codes'] as string[] }),
        ...(typeof args['file'] === 'string' && { file: args['file'] })
      })
    } catch (err) {
      const { DocsError } = await import('@vvpost/core/docs')
      if (err instanceof DocsError) throw new ToolError(`${err.message}; nada foi gravado`, { code: 'VALIDATION' })
      throw err
    }
    const files = plan.files.map((f) => ({ ...f, fixes: f.fixes.map((x) => ({ ...x, message: ctx.sanitizer.text(x.message) })) }))
    if (!apply) return { ok: true, applied: false, total: plan.total, files, ...(plan.total && { hint: 'chame de novo com apply: true para gravar' }) }
    return { ok: true, applied: true, total: plan.total, files, ...(plan.total ? await afterWrite(ctx, false) : {}) }
  }
}

const saveDocsTemplate: McpTool = {
  name: 'save_docs_template',
  title: 'Salvar um modelo de documentação',
  description:
    'Cria um modelo de documentação próprio do projeto (docs/templates/<nome>.doc-template.vvpost.json, vai para o Git), que aparece no editor de documentação do app, em get_docs_project, em save_docs_project (template) e no vvpost docs init --template. ' +
    'Sem config e source, o modelo é o documento do projeto atual. Use para padronizar a documentação do time com uma metodologia própria.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'Nome do modelo.' },
      description: { type: 'string', description: 'Quando usar o modelo.' },
      config: { type: 'object', description: 'Formato (schema docs, sem source). Padrão: o do documento atual.' },
      source: { type: 'string', description: 'Markdown do modelo, com diretivas {{> ...}}. Padrão: o do documento atual.' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    writesBlocked(ctx)
    const docs = await import('@vvpost/core/docs')
    const project = await docs.loadDocsProject(ctx.workspaceDir)
    const source = typeof args['source'] === 'string' ? args['source'] : project.source
    if (source === null) throw new ToolError('o projeto ainda não tem documento: mande source')
    try {
      const saved = await docs.saveDocTemplate(
        await load(ctx),
        {
          name: String(args['name'] ?? ''),
          ...(typeof args['description'] === 'string' && { description: args['description'] }),
          config: args['config'] ?? project.config,
          source
        },
        { origin: 'project' }
      )
      return { ok: true, id: saved.id, file: saved.file, name: saved.name }
    } catch (err) {
      if (err instanceof docs.DocsError) throw new ToolError(err.message)
      throw err
    }
  }
}

const CONFLICT_ENUM = { type: 'object', additionalProperties: { enum: ['merge', 'rename', 'replace'] } }

const importBundle: McpTool = {
  name: 'import_bundle',
  title: 'Importar um pacote do VVPost ou um .vvpost.zip',
  description:
    'Importa um pacote do VVPost pelo plano da revisão do app. Ids existentes seguem conflicts/environmentConflicts/flowConflicts: merge (padrão), rename ou replace; adjustments aplica os ajustes da revisão (renameConnector, setParent, excludeEndpoint...). Sem apply mostra o plano e as operações; com apply: true grava. Segredos ficam pendentes para a pessoa. ' +
    'archive (um .vvpost.zip dentro do projeto) entra como projeto novo do workspace (as troca o id, name o nome), nunca por cima de um que existe; os conectores com credencial e os fluxos com código dele ficam aguardando revisão da pessoa.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      bundle: { description: 'O pacote: objeto JSON ou o texto do arquivo .vvpost.bundle.json.' },
      archive: { type: 'string', description: 'Caminho de um .vvpost.zip dentro do projeto (no lugar de bundle).' },
      as: { type: 'string', description: 'archive: id do projeto novo (padrão: o do zip).' },
      name: { type: 'string', description: 'archive: nome do projeto novo.' },
      adjustments: { type: 'array', items: { type: 'object', required: ['op'] } },
      conflicts: CONFLICT_ENUM,
      environmentConflicts: CONFLICT_ENUM,
      flowConflicts: CONFLICT_ENUM,
      apply: { type: 'boolean', description: 'true: grava (com dryRun, só valida).' },
      dryRun: { type: 'boolean' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async call(args, ctx) {
    if (args['archive'] !== undefined) {
      if (args['bundle'] !== undefined) throw new ToolError('mande bundle ou archive, não os dois', { code: 'INVALID_ARGS' })
      return importZip(args, ctx)
    }
    if (args['bundle'] === undefined) throw new ToolError('mande bundle (o pacote) ou archive (um .vvpost.zip no projeto)', { code: 'INVALID_ARGS' })
    let data = args['bundle']
    if (typeof data === 'string') {
      if (data.length > MAX_IMPORT_CHARS) throw new ToolError(`bundle maior que ${MAX_IMPORT_CHARS / 1024 / 1024} MB`)
      try {
        data = JSON.parse(data)
      } catch (err) {
        throw new ToolError(`bundle: JSON inválido (${(err as Error).message})`)
      }
    }
    if (!isBundle(data)) {
      throw new ToolError('não é um pacote do VVPost ($schema .../bundle.json); para coleções do Postman use import_postman')
    }
    return importPrepared(prepareSources([{ file: 'bundle.json', data }]), args, ctx, 'o pacote')
  }
}

/**
 * import_bundle { archive }: o .vvpost.zip como projeto novo, como o vvpost import <zip> num
 * workspace. Os arquivos entram como estão, sem passar pelas operações da IA, então o que leva
 * credencial (conectores) ou código (fluxos com Python ou plugin) fica aguardando revisão: a IA
 * não dispara com eles até a pessoa confirmar no app.
 */
async function importZip(args: Record<string, unknown>, ctx: ToolContext) {
  const archive = await import('../bundle/archive')
  const { projectLayout } = await import('@vvpost/core/projects')
  let rel: string
  try {
    rel = safeRel(String(args['archive']))
  } catch (err) {
    throw new ToolError((err as Error).message, { code: 'INVALID_ARGS' })
  }
  if (!/\.zip$/i.test(rel)) throw new ToolError('archive precisa ser um .vvpost.zip', { code: 'INVALID_ARGS' })
  let read
  try {
    read = archive.readWorkspaceArchive(await readFile(join(ctx.workspaceDir, rel)), basename(rel))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'VALIDATION'
    throw new ToolError(`archive: ${(err as Error).message}`, { code })
  }
  const text = (k: string) => (typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string).trim() : undefined)
  const wanted = { ...(text('as') && { id: text('as')! }), ...(text('name') && { name: text('name')! }) }
  const root = projectLayout(ctx.workspaceDir).root
  const target = archive.projectTarget(read, root, wanted)
  const plan = {
    kind: read.manifest.kind,
    project: { id: target.id, name: target.name, folder: target.id },
    summary: read.summary,
    ...(read.warnings.length && { warnings: read.warnings }),
    ...(!projectLayout(root).projects.length && {
      note: 'o workspace não tem projetos: com o zip, o que está na raiz passa a ser o Compartilhado, visível no projeto novo; confirme com a pessoa antes'
    })
  }
  if (target.blocked) throw new ToolError(target.blocked, { code: 'VALIDATION', hint: 'abra o zip como workspace novo pelo app ou por vvpost import --workspace <pasta>' })
  if (target.taken) throw new ToolError(`${target.taken}; use as: "<outro-id>"`, { code: 'CONFLICT', hint: 'list_projects mostra os projetos que já existem' })
  if (args['apply'] !== true || args['dryRun'] === true) return { ...plan, applied: false }
  writesBlocked(ctx)
  let result
  try {
    result = await archive.importArchiveAsProject(read, ctx.workspaceDir, wanted)
  } catch (err) {
    throw new ToolError((err as Error).message, { code: 'VALIDATION' })
  }
  const review = await markImportedForReview(result.dir)
  return {
    ok: true,
    ...plan,
    files: result.written.length,
    ...(review.length && { review, note: 'aguardando revisão da pessoa no app (Catálogo › Alterações da IA): até lá, só plan nesses conectores e fluxos' }),
    ...(result.pendingSecrets && { pendingSecrets: result.pendingSecrets }),
    ...(result.warnings.length && { warnings: result.warnings })
  }
}

/** Conectores com credencial e fluxos com código de um projeto que a IA trouxe inteiro. */
async function markImportedForReview(dir: string): Promise<string[]> {
  const [{ loadWorkspace }, { connectorFingerprints }, { addReviewMarks, markUnreviewedFlows }] = await Promise.all([
    import('@vvpost/core/connectors/workspace'),
    import('../project/guard'),
    import('../project/review')
  ])
  const ws = await loadWorkspace(dir)
  const own = [...ws.connectors.keys()].filter((id) => !ws.shared?.has(id))
  const prints = connectorFingerprints(ws.connectors, [...ws.environments.values()])
  const connectors = own.filter((id) => prints.get(id) != null)
  const reasons = Object.fromEntries(connectors.map((id) => [id, 'importado pela IA de um .vvpost.zip: auth, destino e credenciais']))
  if (connectors.length) await addReviewMarks(dir, connectors, new Date(), reasons)
  return [...connectors, ...(await markUnreviewedFlows(dir))]
}

/**
 * Plano e gravação de um import já preparado (pacote do VVPost ou spec OpenAPI), pelo
 * mesmo planImport da revisão do app. A IA nunca grava valor de segredo.
 */
async function importPrepared(prepared: PreparedImport, args: Record<string, unknown>, ctx: ToolContext, what: string) {
  for (const s of prepared.result.secrets) ctx.sanitizer.add(s.value)
  await load(ctx)
  const input: ImportPlanInput = {
    adjustments: (args['adjustments'] as ImportPlanInput['adjustments']) ?? [],
    conflicts: (args['conflicts'] as Record<string, ImportConflictMode>) ?? {},
    environmentConflicts: (args['environmentConflicts'] as Record<string, ImportConflictMode>) ?? {},
    flowConflicts: (args['flowConflicts'] as Record<string, ImportConflictMode>) ?? {},
    syncDecisions: (args['syncDecisions'] as ImportPlanInput['syncDecisions']) ?? {}
  }
  const plan = planImport(prepared.result, await loadProject(ctx.workspaceDir), input)
  // A IA não grava valor de segredo: o que o import trouxe fica pendente para o usuário.
  const ops = plan.ops.filter((o) => o.op !== 'storeSecret') as ProjectOp[]
  const errors = [...prepared.result.errors, ...prepared.invalid]
  const summary = {
    connectors: plan.connectors
      .filter((c) => !c.untouched)
      .map((c) => ({
        id: c.id,
        name: c.name,
        origin: c.origin,
        ...(c.conflict && { conflict: c.conflict }),
        ...(c.extends && { extends: c.extends }),
        newEndpoints: c.endpoints.filter((e) => e.status === 'new').map((e) => e.id),
        ...(c.endpoints.some((e) => e.sync) && {
          specSync: c.endpoints
            .filter((e) => e.sync)
            .map((e) => ({ key: e.sync!.key, status: e.status, decision: e.sync!.decision, changes: e.sync!.changes }))
        })
      })),
    environments: plan.environments.map((e) => ({ id: e.id, origin: e.origin, excluded: e.excluded, ...(e.conflict && { conflict: e.conflict }) })),
    flows: plan.flows.map((f) => ({
      id: f.id,
      origin: f.origin,
      excluded: f.excluded,
      ...(f.conflict && { conflict: f.conflict }),
      ...(f.missingConnectors && { missingConnectors: f.missingConnectors })
    })),
    docs: plan.docs,
    ...(prepared.result.secrets.length && {
      pendingSecrets: {
        variables: prepared.result.secrets.map((s) => `${s.environmentId}/${s.variable}`),
        note: `${what} trazia valores de segredo: não foram gravados pela IA; o usuário preenche no app (Git › pendências)`
      }
    }),
    ...(prepared.result.warnings.length && { warnings: prepared.result.warnings }),
    ...(plan.notes.length && { notes: plan.notes }),
    ...(plan.errors.length && { adjustmentErrors: plan.errors }),
    ...(errors.length && { errors })
  }
  const apply = args['apply'] === true
  if (apply) writesBlocked(ctx)
  if (errors.length) {
    if (apply) throw new ToolError(`${what} tem problemas: ${errors.slice(0, 3).map((e) => `${e.file}: ${e.message}`).join('; ')}`)
    return { ...summary, ops }
  }
  if (!ops.length) return { ...summary, ok: true, changes: [], note: 'nada para importar: tudo já está no projeto' }
  const result = await applyProjectOps(ctx.workspaceDir, ops, {
    actor: 'ai',
    dryRun: !apply || args['dryRun'] === true,
    checkText: (_path, content) => (ctx.sanitizer.leaks(content) ? 'contém o valor de uma credencial real' : undefined)
  })
  if (result.ok && !result.dryRun) ctx.auth.clear()
  return { ...summary, ...report(result, ops), ...(!apply && { ops, note: 'nada foi gravado: mande de novo com apply: true (ou ajuste as ops e use edit_project)' }) }
}

const importOpenApi: McpTool = {
  name: 'import_openapi',
  title: 'Importar ou reimportar uma spec OpenAPI',
  description:
    'Importa ou reimporta uma spec OpenAPI 3.x/Swagger 2.0 (JSON ou YAML) de location (URL ou caminho no projeto) ou de spec: conector raiz com a URL do servidor e a auth em {{VAR}}, um filho por tag, um endpoint por operação. Na reimportação, specSync mostra atualizados, em conflito e removidos, e syncDecisions ("spec" ou "keep" por "<conector>/<endpoint>") decide. conflicts e adjustments como no import_bundle. Sem apply mostra o plano; com apply: true grava.',
  inputSchema: {
    type: 'object',
    required: ['location'],
    additionalProperties: false,
    properties: {
      location: { type: 'string', description: 'URL da spec, ou caminho relativo à pasta do projeto.' },
      spec: { description: 'Opcional: a spec já lida (objeto ou texto JSON/YAML), no lugar de ler de location.' },
      syncDecisions: { type: 'object', additionalProperties: { enum: ['spec', 'keep'] } },
      adjustments: { type: 'array', items: { type: 'object', required: ['op'] } },
      conflicts: CONFLICT_ENUM,
      apply: { type: 'boolean', description: 'true: grava (com dryRun, só valida).' },
      dryRun: { type: 'boolean' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async call(args, ctx) {
    const location = typeof args['location'] === 'string' ? args['location'].trim() : ''
    if (!location) throw new ToolError('location: diga a URL ou o caminho da spec')
    let stored = location
    if (!isUrl(location)) {
      const full = resolve(ctx.workspaceDir, location)
      const rel = relative(ctx.workspaceDir, full)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ToolError('location: o caminho precisa estar dentro da pasta do projeto (ou use uma URL)')
      stored = rel.split(sep).join('/')
    }
    let data = args['spec']
    try {
      if (typeof data === 'string') {
        if (data.length > MAX_IMPORT_CHARS) throw new ToolError(`spec maior que ${MAX_IMPORT_CHARS / 1024 / 1024} MB`)
        data = parseImportText(data, basename(stored))
      } else if (data === undefined) {
        data = await readSourceLocation(stored, ctx.workspaceDir)
      }
    } catch (err) {
      if (err instanceof ToolError) throw err
      throw new ToolError(`spec: ${(err as Error).message}`)
    }
    if (!isOpenApi(data)) throw new ToolError('não é uma spec OpenAPI 3.x nem Swagger 2.0 (falta "openapi": "3.x" ou "swagger": "2.0")')
    const file = basename(stored.replace(/[?#].*$/, '')) || stored
    return importPrepared(prepareSources([{ file, data, location: stored }]), args, ctx, 'a spec')
  }
}

const syncOpenApi: McpTool = {
  name: 'sync_openapi',
  title: 'Sincronizar com a spec OpenAPI do código',
  description:
    'A spec OpenAPI do código como fonte do contrato: relê a spec de cada conector vinculado (source.location) e devolve o drift por spec (endpoints new, updated, conflict, edited, linked e removed, com os campos que diferem e o que depende de um removido; schemas; onlyInProject) e breaks (o que a validação acusaria depois do sync, como corpo de cenário fora do schema novo). A spec ganha nos campos de contrato (nome, descrição, método, caminho, se exige auth, headers, query, bodySchema, corpo de exemplo); um endpoint público que passa a exigir auth é quebra; cenários, exemplos, scripts, docs, fluxos, ambientes e a config do conector ficam. Sem apply só relata; apply: true grava. link + connector vincula um conector feito à mão a uma spec (URL ou caminho no projeto) e adota os endpoints com o mesmo método e caminho. prune apaga o que saiu da spec; keepEdits mantém o que foi editado no projeto. Depois de mudar a API no código e regerar a spec, rode este e depois os cenários.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      connector: {
        description: 'Só a spec deste conector (ou destes). Com link, o conector a vincular.',
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
      },
      link: { type: 'string', description: 'Vincula connector a esta spec: URL, ou caminho relativo à pasta do projeto.' },
      prune: { type: 'boolean', description: 'Apaga os endpoints que saíram da spec (sem isso ficam, como drift).' },
      keepEdits: { type: 'boolean', description: 'Endpoint ou schema editado no projeto fica com a edição (padrão: a spec ganha).' },
      apply: { type: 'boolean', description: 'true: grava.' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async call(args, ctx) {
    const connectors = (Array.isArray(args['connector']) ? args['connector'] : args['connector'] === undefined ? [] : [args['connector']]).map((c) => {
      if (typeof c !== 'string' || !c.trim()) throw new ToolError('connector: o id do conector')
      return c.trim()
    })
    let link: { connector: string; location: string } | undefined
    if (args['link'] !== undefined) {
      const location = typeof args['link'] === 'string' ? args['link'].trim() : ''
      if (!location) throw new ToolError('link: a URL da spec, ou o caminho dela no projeto')
      if (connectors.length !== 1) throw new ToolError('link: diga em connector qual conector vincular')
      if (!isUrl(location)) {
        const rel = relative(ctx.workspaceDir, resolve(ctx.workspaceDir, location))
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ToolError('link: o caminho precisa estar dentro da pasta do projeto (ou use uma URL)')
      }
      link = { connector: connectors[0]!, location: isUrl(location) ? location : resolve(ctx.workspaceDir, location) }
    }
    const apply = args['apply'] === true
    if (apply) writesBlocked(ctx)
    const report = await syncSpecSources(ctx.workspaceDir, {
      ...(link ? { link } : connectors.length && { connectors }),
      prune: args['prune'] === true,
      keepEdits: args['keepEdits'] === true,
      apply,
      actor: 'ai',
      checkText: (_path, content) => (ctx.sanitizer.leaks(content) ? 'contém o valor de uma credencial real' : undefined)
    })
    if (apply && report.ok && report.results.some((r) => r.changes.length)) ctx.auth.clear()
    return {
      ...report,
      inSync: report.results.every((r) => !r.drift),
      ...(!apply && report.results.some((r) => r.changes.length) && { note: 'nada foi gravado: mande de novo com apply: true' })
    }
  }
}

const importCollection: McpTool = {
  name: 'import_collection',
  title: 'Importar do Insomnia, Bruno, HAR ou WSDL',
  description:
    'Importa Insomnia (v4 JSON, v5 YAML), Bruno (pasta, .bru ou JSON), HAR ou WSDL 1.1 de location (URL, arquivo ou pasta no projeto) ou de content (com file dando o nome), pelo plano da revisão do app: pastas viram conectores filhos, requisições viram endpoints. conflicts, environmentConflicts e adjustments como no import_bundle. Sem apply mostra o plano; com apply: true grava. Segredos ficam pendentes.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      location: { type: 'string', description: 'URL, ou caminho de arquivo ou pasta dentro do projeto.' },
      content: { description: 'Opcional: o conteúdo já lido (objeto JSON ou texto), no lugar de location.' },
      file: { type: 'string', description: 'Com content: o nome do arquivo de origem (ex.: loja.har, pedido.bru, servico.wsdl).' },
      adjustments: { type: 'array', items: { type: 'object', required: ['op'] } },
      conflicts: CONFLICT_ENUM,
      environmentConflicts: CONFLICT_ENUM,
      apply: { type: 'boolean', description: 'true: grava (com dryRun, só valida).' },
      dryRun: { type: 'boolean' }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  async call(args, ctx) {
    const location = typeof args['location'] === 'string' ? args['location'].trim() : ''
    let data = args['content']
    let file = typeof args['file'] === 'string' && args['file'].trim() ? basename(args['file'].trim()) : ''
    try {
      if (typeof data === 'string') {
        if (data.length > MAX_IMPORT_CHARS) throw new ToolError(`content maior que ${MAX_IMPORT_CHARS / 1024 / 1024} MB`)
        data = parseImportText(data, file || 'import.json')
      } else if (data === undefined) {
        if (!location) throw new ToolError('diga de onde importar: location (URL ou caminho no projeto) ou content')
        if (isUrl(location)) data = await fetchImportUrl(location)
        else {
          const full = resolve(ctx.workspaceDir, location)
          const rel = relative(ctx.workspaceDir, full)
          if (rel.startsWith('..') || isAbsolute(rel)) throw new ToolError('location: o caminho precisa estar dentro da pasta do projeto (ou use uma URL)')
          data = await readImportFile(full)
        }
        file ||= basename(location.replace(/[?#].*$/, '')) || location
      }
    } catch (err) {
      if (err instanceof ToolError) throw err
      throw new ToolError(`${location || file || 'content'}: ${(err as Error).message}`)
    }
    file ||= 'import.json'
    if (!isForeignImport(file, data)) {
      throw new ToolError(
        'não é uma exportação do Insomnia, uma coleção do Bruno, um HAR nem um WSDL; para o Postman use import_postman, para OpenAPI import_openapi e para pacotes do VVPost import_bundle'
      )
    }
    return importPrepared(prepareSources([{ file, data, ...(location && { location }) }]), args, ctx, 'a coleção')
  }
}

/** Ferramentas que gravam no projeto (get_source e get_schema só leem, mas só servem para editar). */
export const EDIT_TOOLS: readonly McpTool[] = [
  getSchema,
  getSource,
  editProject,
  importPostman,
  exportProject,
  importBundle,
  importOpenApi,
  syncOpenApi,
  importCollection,
  generateDocs,
  getDocsProject,
  saveDocsProject,
  writeDocsPage,
  fixDiagrams,
  saveDocsTemplate,
  findReferences,
  replaceReferences,
  exportDocs
]
