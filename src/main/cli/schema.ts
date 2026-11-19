import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BODY_FIELD_TYPES, type BodyFieldSpec, type BodyFieldType } from '@vvpost/core/connectors/body-schema'
import { schemaFields } from '@vvpost/core/connectors/registry'
import { loadWorkspace } from '@vvpost/core/connectors/workspace'
import { applyProjectOps, type ProjectOp } from '../project'
import type { Io } from './index'

export interface SchemaValues {
  set?: string
  remove?: string[]
  required?: boolean
  description?: string
  enum?: string
  format?: string
  items?: string
  'from-body'?: boolean
  file?: string
  clear?: boolean
  'dry-run'?: boolean
  json?: string
}

export const SCHEMA_HELP = `Uso: vvpost schema <conector>/<endpoint> [opções]

Mostra e edita os campos do corpo do endpoint (o bodySchema, que monta o formulário tipado do app
e a tabela de campos da documentação), sem escrever JSON Schema à mão. Sem opções, lista os campos.

  --set <caminho>:<tipo>  Cria ou troca um campo. Tipos: ${BODY_FIELD_TYPES.join(', ')}.
                          Caminho: valor, cliente.nome ou itens[].sku (campo dos objetos da lista)
    --required            O campo é obrigatório (sem ela, opcional)
    --description <texto> Descrição do campo
    --enum <a,b,c>        Valores aceitos (string, integer ou number)
    --format <formato>    Formato de string: date, date-time, email, uuid, uri...
    --items <tipo>        Tipo dos itens, num campo array (padrão: string)
  --remove <caminho>      Remove um campo (repetível)
  --from-body             Gera o schema do corpo padrão do endpoint (tipos pelos valores, nenhum obrigatório)
  --file <schema.json>    Troca o schema inteiro por este JSON Schema
  --clear                 Tira o schema do endpoint
  --dry-run               Só mostra o que mudaria
  --json -                Escreve o JSON Schema resultante no stdout
`

/** vvpost schema: lê e edita o bodySchema de um endpoint pelas operações do projeto (as mesmas do MCP). */
export async function schemaCommand(dir: string, io: Io, values: SchemaValues, target: string | undefined): Promise<number> {
  const [connectorId, endpointId, ...rest] = (target ?? '').split('/')
  if (!connectorId || !endpointId || rest.length) {
    io.stderr(`vvpost: diga o endpoint: vvpost schema <conector>/<endpoint>\n\n${SCHEMA_HELP}`)
    return 2
  }
  let ops: ProjectOp[]
  try {
    ops = await schemaOps(connectorId, endpointId, values, io.cwd)
  } catch (err) {
    io.stderr(`vvpost: ${(err as Error).message}\n`)
    return 2
  }

  let schema: Record<string, unknown> | undefined
  if (ops.length) {
    const result = await applyProjectOps(dir, ops, { dryRun: values['dry-run'] === true })
    for (const w of result.warnings) io.stderr(`aviso: ${w.message}\n`)
    if (!result.ok) {
      for (const e of result.errors) io.stderr(`vvpost: ${e.message}\n`)
      return 2
    }
    const after = result.changes[0]?.after
    if (after) schema = (JSON.parse(after) as { endpoints?: { id: string; bodySchema?: Record<string, unknown> }[] }).endpoints?.find((e) => e.id === endpointId)?.bodySchema
    else schema = await currentSchema(dir, connectorId, endpointId)
    if (values.json !== '-')
      io.stdout(`${values['dry-run'] ? 'Mudaria' : 'Gravado'}: ${result.changes.map((c) => c.path).join(', ') || 'nada mudou'}\n`)
  } else {
    try {
      schema = await currentSchema(dir, connectorId, endpointId)
    } catch (err) {
      io.stderr(`vvpost: ${(err as Error).message}\n`)
      return 2
    }
  }

  if (values.json === '-') {
    io.stdout(`${JSON.stringify(schema ?? null, null, 2)}\n`)
    return 0
  }
  io.stdout(fieldsTable(schema))
  return 0
}

async function schemaOps(connectorId: string, endpointId: string, values: SchemaValues, cwd: string): Promise<ProjectOp[]> {
  const at = { connectorId, endpointId }
  const ops: ProjectOp[] = []
  const modes = [values.clear, values['from-body'], values.file !== undefined].filter(Boolean).length
  if (modes > 1) throw new Error('use só uma de --clear, --from-body e --file')
  if (values.clear) ops.push({ op: 'setBodySchema', ...at, schema: null })
  if (values['from-body']) ops.push({ op: 'setBodySchema', ...at, fromBody: true })
  if (values.file !== undefined) {
    let schema: unknown
    try {
      schema = JSON.parse(await readFile(resolve(cwd, values.file), 'utf8'))
    } catch (err) {
      throw new Error(`--file ${values.file}: ${err instanceof SyntaxError ? `JSON inválido (${err.message})` : (err as Error).message}`)
    }
    ops.push({ op: 'setBodySchema', ...at, schema: schema as Record<string, unknown> })
  }
  for (const path of values.remove ?? []) ops.push({ op: 'setBodyField', ...at, path, field: null })
  const fieldOnly = ['required', 'description', 'enum', 'format', 'items'] as const
  if (values.set !== undefined) {
    const split = values.set.lastIndexOf(':')
    if (split <= 0) throw new Error(`--set ${values.set}: use <caminho>:<tipo>, ex.: cliente.nome:string`)
    const type = values.set.slice(split + 1) as BodyFieldType
    if (!BODY_FIELD_TYPES.includes(type)) throw new Error(`--set: tipo "${type}" inválido; use ${BODY_FIELD_TYPES.join(', ')}`)
    if (values.items !== undefined && !BODY_FIELD_TYPES.includes(values.items as BodyFieldType))
      throw new Error(`--items: tipo "${values.items}" inválido; use ${BODY_FIELD_TYPES.join(', ')}`)
    const field: BodyFieldSpec = {
      type,
      ...(values.required && { required: true }),
      ...(values.description && { description: values.description }),
      ...(values.enum && { enum: values.enum.split(',').map((v) => v.trim()).filter(Boolean) }),
      ...(values.format && { format: values.format }),
      ...(values.items && { items: values.items as BodyFieldType })
    }
    ops.push({ op: 'setBodyField', ...at, path: values.set.slice(0, split), field })
  } else {
    const stray = fieldOnly.filter((k) => values[k] !== undefined)
    if (stray.length) throw new Error(`--${stray[0]} só vale junto com --set <caminho>:<tipo>`)
  }
  return ops
}

async function currentSchema(dir: string, connectorId: string, endpointId: string): Promise<Record<string, unknown> | undefined> {
  const ws = await loadWorkspace(dir)
  const connector = ws.connectors.get(connectorId)
  if (!connector) throw new Error(`conector "${connectorId}" não existe no workspace`)
  const endpoint = connector.endpoints?.find((e) => e.id === endpointId)
  if (!endpoint) throw new Error(`o conector "${connectorId}" não tem o endpoint "${endpointId}"`)
  return endpoint.bodySchema
}

function fieldsTable(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'Sem schema do corpo. Crie com --set <caminho>:<tipo> ou --from-body.\n'
  const fields = schemaFields(schema)
  if (!fields.length) return 'O schema não tem campos de objeto (veja com --json -).\n'
  const rows = fields.map((f) => [f.path + (f.required ? ' *' : ''), f.values ? f.values.join(' | ') : f.type, f.description ?? ''])
  const width = [0, 1].map((i) => Math.max(...rows.map((r) => r[i]!.length), i ? 4 : 5))
  const line = (r: string[]) => `${r[0]!.padEnd(width[0]!)}  ${r[1]!.padEnd(width[1]!)}  ${r[2]}`.trimEnd()
  return `${[line(['Campo', 'Tipo', 'Descrição']), ...rows.map(line)].join('\n')}\n(* obrigatório)\n`
}
