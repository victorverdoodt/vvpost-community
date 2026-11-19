import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, Trash2, Wand2 } from 'lucide-react'
import { BODY_FIELD_TYPES, inferBodySchema, type BodyFieldType } from '@vvpost/core/connectors/body-schema'
import { cx } from '../cx'
import { Button, controlClass, IconButton } from '../primitives/Button'

type Schema = Record<string, unknown>
const isRecord = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v)
const icon = { size: 13, 'aria-hidden': true } as const
const input = `${controlClass} min-w-0`
const FORMATS = ['', 'date', 'date-time', 'email', 'uuid', 'uri', 'password'] as const
const TYPE_LABEL: Record<BodyFieldType, string> = {
  string: 'texto',
  integer: 'inteiro',
  number: 'número',
  boolean: 'booleano',
  object: 'objeto',
  array: 'lista'
}

/** Tipo editável do campo, ou null quando o schema dele é avançado ($ref, oneOf, sem tipo...). */
function simpleType(s: Schema): BodyFieldType | null {
  if (s['$ref'] !== undefined || s['oneOf'] !== undefined || s['anyOf'] !== undefined || s['allOf'] !== undefined) return null
  const t = Array.isArray(s['type']) ? s['type'].find((x) => x !== 'null') : s['type']
  return BODY_FIELD_TYPES.includes(t as BodyFieldType) ? (t as BodyFieldType) : null
}

/** O schema com outro tipo: guarda descrição e, num objeto ou lista, os campos que já tinha. */
function withType(s: Schema, type: BodyFieldType): Schema {
  const next: Schema = { type }
  if (typeof s['description'] === 'string') next['description'] = s['description']
  if (type === 'object') {
    next['properties'] = isRecord(s['properties']) ? s['properties'] : {}
    if (Array.isArray(s['required'])) next['required'] = s['required']
  }
  if (type === 'array') next['items'] = isRecord(s['items']) ? s['items'] : { type: 'string' }
  if (type === 'string' && typeof s['format'] === 'string') next['format'] = s['format']
  return next
}

/**
 * Editor visual do schema do corpo (o bodySchema do endpoint), para quem não importa OpenAPI e não
 * quer escrever JSON Schema: uma linha por campo com nome, tipo, obrigatório e descrição; enum e
 * formato em "mais"; objetos e listas de objetos abrem os campos deles. Campos com schema avançado
 * ($ref, oneOf) aparecem só para remover: o resto do schema ($defs, referências) não muda.
 */
export function SchemaBuilder(props: {
  value: Schema | undefined
  onChange: (value: Schema | undefined) => void
  /** Corpo padrão do endpoint, para "Gerar do corpo". */
  body?: unknown
  label?: string
}) {
  const root = props.value
  const body = typeof props.body === 'string' ? safeParse(props.body) : props.body
  const canInfer = isRecord(body) || Array.isArray(body)
  const rootIsObject = !root || (simpleType(root) === 'object' || (root['type'] === undefined && isRecord(root['properties'])))
  const set = (next: Schema) => {
    // Sem nenhum campo e sem $defs, o endpoint fica sem schema (o JSON some do arquivo).
    const empty = isRecord(next['properties']) && Object.keys(next['properties']).length === 0 && !next['$defs']
    props.onChange(empty ? undefined : next)
  }
  return (
    <div role="group" aria-label={props.label ?? 'Campos do corpo'} className="flex flex-col gap-2 text-xs">
      {rootIsObject ? (
        <Properties schema={root ?? { type: 'object', properties: {} }} onChange={set} depth={0} prefix="" />
      ) : (
        <p className="text-muted">O schema do corpo não é um objeto (é uma lista ou uma referência): edite no JSON Schema.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {canInfer && (
          <Button
            size="sm"
            variant="secondary"
            title="Cria os campos pelos valores do corpo padrão: tipos e formatos de data e e-mail, nenhum obrigatório"
            onClick={() => props.onChange(inferBodySchema(body))}
          >
            <Wand2 {...icon} /> {root ? 'Gerar de novo do corpo padrão' : 'Gerar do corpo padrão'}
          </Button>
        )}
        {root && (
          <Button size="sm" variant="ghost" onClick={() => props.onChange(undefined)}>
            <Trash2 {...icon} /> Tirar o schema
          </Button>
        )}
      </div>
    </div>
  )
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Os campos de um objeto: uma linha por propriedade e "+ campo" no fim. */
function Properties(props: { schema: Schema; onChange: (next: Schema) => void; depth: number; prefix: string }) {
  const { schema } = props
  const properties = isRecord(schema['properties']) ? schema['properties'] : {}
  const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : [])
  const names = Object.keys(properties)
  const commit = (nextProps: Schema, nextRequired: Set<string>) => {
    const next: Schema = { ...schema, type: schema['type'] ?? 'object', properties: nextProps }
    const req = [...nextRequired].filter((n) => n in nextProps)
    if (req.length) next['required'] = req
    else delete next['required']
    props.onChange(next)
  }
  const add = () => {
    let n = names.length + 1
    while (`campo${n}` in properties) n++
    commit({ ...properties, [`campo${n}`]: { type: 'string' } }, required)
  }
  return (
    <div className={cx('flex flex-col gap-1.5', props.depth > 0 && 'border-l border-border-subtle pl-3')}>
      {names.length === 0 && props.depth === 0 && <p className="text-muted">Nenhum campo ainda.</p>}
      {names.map((name) => (
        <FieldRow
          key={name}
          name={name}
          path={`${props.prefix}${name}`}
          schema={isRecord(properties[name]) ? (properties[name] as Schema) : {}}
          required={required.has(name)}
          taken={names}
          depth={props.depth}
          onRename={(to) => {
            const reordered = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k === name ? to : k, v]))
            const req = new Set([...required].map((r) => (r === name ? to : r)))
            commit(reordered, req)
          }}
          onChange={(s) => commit({ ...properties, [name]: s }, required)}
          onRequired={(on) => {
            const req = new Set(required)
            if (on) req.add(name)
            else req.delete(name)
            commit(properties, req)
          }}
          onRemove={() => {
            const { [name]: _, ...rest } = properties
            commit(rest, required)
          }}
        />
      ))}
      <button
        type="button"
        aria-label={props.prefix ? `Adicionar campo em ${props.prefix.replace(/\.$/, '')}` : 'Adicionar campo'}
        onClick={add}
        className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-muted hover:bg-elevated hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Plus {...icon} /> campo
      </button>
    </div>
  )
}

function FieldRow(props: {
  name: string
  path: string
  schema: Schema
  required: boolean
  taken: string[]
  depth: number
  onRename: (to: string) => void
  onChange: (s: Schema) => void
  onRequired: (on: boolean) => void
  onRemove: () => void
}) {
  const { schema: s, path } = props
  const type = simpleType(s)
  const [name, setName] = useState(props.name)
  useEffect(() => setName(props.name), [props.name])
  const hasMore = s['enum'] !== undefined || s['format'] !== undefined
  const [more, setMore] = useState(hasMore)
  const nameProblem =
    !name.trim() ? 'o nome não pode ficar vazio' : name !== props.name && props.taken.includes(name) ? `já existe o campo ${name}` : null
  const set = (patch: Schema) => {
    const next: Schema = { ...s, ...patch }
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k]
    props.onChange(next)
  }
  const items = isRecord(s['items']) ? (s['items'] as Schema) : undefined
  const itemType = items ? simpleType(items) : null

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {type ? (
          <IconButton label={more ? `Menos opções de ${path}` : `Mais opções de ${path}`} onClick={() => setMore(!more)}>
            {more ? <ChevronDown {...icon} /> : <ChevronRight {...icon} />}
          </IconButton>
        ) : (
          <span className="w-6" />
        )}
        <input
          aria-label={`Nome do campo ${path}`}
          className={cx(input, 'w-36 font-mono', nameProblem && 'border-danger')}
          value={name}
          title={nameProblem ?? undefined}
          spellCheck={false}
          onChange={(e) => setName(e.target.value.replace(/[.\s[\]]/g, '_'))}
          onBlur={() => (nameProblem ? setName(props.name) : name !== props.name && props.onRename(name))}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {type ? (
          <select
            aria-label={`Tipo de ${path}`}
            className={cx(input, 'w-24')}
            value={type}
            onChange={(e) => props.onChange(withType(s, e.target.value as BodyFieldType))}
          >
            {BODY_FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        ) : (
          <span className="w-24 text-muted" title="Schema com $ref, oneOf ou sem tipo: edite no JSON Schema">
            avançado
          </span>
        )}
        {type === 'array' && (
          <select
            aria-label={`Tipo dos itens de ${path}`}
            className={cx(input, 'w-28')}
            value={itemType ?? ''}
            onChange={(e) => set({ items: withType(items ?? {}, e.target.value as BodyFieldType) })}
          >
            {!itemType && <option value="">avançado</option>}
            {BODY_FIELD_TYPES.filter((t) => t !== 'array').map((t) => (
              <option key={t} value={t}>
                de {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-1 text-muted">
          <input type="checkbox" aria-label={`${path} obrigatório`} checked={props.required} onChange={(e) => props.onRequired(e.target.checked)} />
          obrigatório
        </label>
        <input
          aria-label={`Descrição de ${path}`}
          placeholder="descrição"
          className={cx(input, 'min-w-24 flex-1 basis-24')}
          value={typeof s['description'] === 'string' ? s['description'] : ''}
          onChange={(e) => set({ description: e.target.value || undefined })}
        />
        <IconButton label={`Remover o campo ${path}`} onClick={props.onRemove}>
          <Trash2 {...icon} />
        </IconButton>
      </div>
      {more && type && <MoreOptions path={path} schema={s} type={type} set={set} />}
      {type === 'object' && <Properties schema={s} onChange={props.onChange} depth={props.depth + 1} prefix={`${path}.`} />}
      {type === 'array' && itemType === 'object' && (
        <Properties schema={items!} onChange={(next) => set({ items: next })} depth={props.depth + 1} prefix={`${path}[].`} />
      )}
    </div>
  )
}

/** Valores aceitos (enum), formato da string, mínimo e máximo. */
function MoreOptions(props: { path: string; schema: Schema; type: BodyFieldType; set: (patch: Schema) => void }) {
  const { schema: s, type, path } = props
  const enumText = Array.isArray(s['enum']) ? s['enum'].map(String).join(', ') : ''
  const [values, setValues] = useState(enumText)
  useEffect(() => setValues(enumText), [enumText])
  const numeric = type === 'integer' || type === 'number'
  const parseEnum = (text: string) => {
    const list = text
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => (numeric ? Number(v.replace(',', '.')) : v))
      .filter((v) => typeof v === 'string' || (Number.isFinite(v) && (type !== 'integer' || Number.isInteger(v))))
    return list.length ? list : undefined
  }
  const limit = (key: string, label: string) => (
    <input
      aria-label={`${label} de ${path}`}
      placeholder={label}
      inputMode="numeric"
      className={cx(input, 'w-20')}
      value={typeof s[key] === 'number' ? String(s[key]) : ''}
      onChange={(e) => {
        const n = Number(e.target.value)
        props.set({ [key]: e.target.value.trim() && Number.isFinite(n) ? n : undefined })
      }}
    />
  )
  return (
    <div className="ml-7 flex flex-wrap items-center gap-1.5">
      {(type === 'string' || numeric) && (
        <input
          aria-label={`Valores aceitos de ${path}`}
          placeholder="valores aceitos, separados por vírgula (enum)"
          className={cx(input, 'flex-1 basis-56 font-mono')}
          value={values}
          spellCheck={false}
          onChange={(e) => setValues(e.target.value)}
          onBlur={() => props.set({ enum: parseEnum(values) })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
      {type === 'string' && (
        <select
          aria-label={`Formato de ${path}`}
          className={cx(input, 'w-28')}
          value={typeof s['format'] === 'string' ? s['format'] : ''}
          onChange={(e) => props.set({ format: e.target.value || undefined })}
        >
          {FORMATS.map((f) => (
            <option key={f} value={f}>
              {f || 'sem formato'}
            </option>
          ))}
          {typeof s['format'] === 'string' && !FORMATS.includes(s['format'] as (typeof FORMATS)[number]) && (
            <option value={s['format']}>{s['format']}</option>
          )}
        </select>
      )}
      {numeric && (
        <>
          {limit('minimum', 'mínimo')}
          {limit('maximum', 'máximo')}
        </>
      )}
      {type === 'string' && (
        <>
          {limit('minLength', 'mín. caracteres')}
          {limit('maxLength', 'máx. caracteres')}
        </>
      )}
      {type === 'boolean' && <span className="text-muted">Sem outras opções para booleano.</span>}
      {(type === 'object' || type === 'array') && <span className="text-muted">Os campos ficam abaixo.</span>}
    </div>
  )
}
