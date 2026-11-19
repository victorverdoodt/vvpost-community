import { Plus, Trash2 } from 'lucide-react'
import { cx } from '../cx'
import { controlClass, IconButton } from '../primitives/Button'
import {
  enumKey,
  enumValues,
  extraKeys,
  fieldKind,
  getIn,
  initialValue,
  isNullable,
  MAX_FORM_DEPTH,
  parseNumberInput,
  pickVariant,
  resolveSchema,
  setIn,
  typeLabel,
  variantLabel,
  variantsOf,
  type FormPath,
  type Schema
} from './schema-form'

const icon = { size: 13, 'aria-hidden': true } as const
const inputClass = `${controlClass} w-full font-mono`

/** Nome do campo para leitores de tela e testes: pedido.itens[0].sku. */
function pathName(path: FormPath): string {
  return path.reduce<string>((out, k) => (typeof k === 'number' ? `${out}[${k}]` : out ? `${out}.${k}` : k), '') || 'corpo'
}

interface Ctx {
  root: Schema
  value: unknown
  onChange: (value: unknown) => void
  set: (path: FormPath, next: unknown) => void
}

/**
 * Formulário gerado do JSON Schema do corpo (ex.: o bodySchema vindo do OpenAPI): cada propriedade
 * vira um campo com o controle do tipo dela (seletor para enum e booleano, número, texto, data),
 * obrigatórios marcados, descrição embaixo, objetos aninhados, listas e oneOf/anyOf com seletor.
 * Edita o valor por caminho: campos fora do schema continuam no corpo, e o JSON raw mostra tudo.
 */
export function SchemaForm(props: { schema: Schema; value: unknown; onChange: (value: unknown) => void; label?: string }) {
  const ctx: Ctx = {
    root: props.schema,
    value: props.value,
    onChange: props.onChange,
    set: (path, next) => props.onChange(setIn(props.value, path, next))
  }
  return (
    <div role="group" aria-label={props.label ?? 'Formulário do corpo'} className="flex flex-col gap-2 text-xs">
      <Node ctx={ctx} raw={props.schema} path={[]} depth={0} required />
    </div>
  )
}

/** Um valor do schema no caminho: oneOf vira seletor de ramo; objeto e lista abrem; o resto é um campo. */
function Node(props: { ctx: Ctx; raw: unknown; path: FormPath; depth: number; required: boolean; name?: string }) {
  const { ctx, path, depth } = props
  const s = resolveSchema(ctx.root, props.raw)
  const value = getIn(ctx.value, path)
  if (depth > MAX_FORM_DEPTH) return <p className="text-muted">Campo aninhado demais para o formulário: edite no JSON.</p>

  const rawVariants = Array.isArray(s['oneOf']) ? s['oneOf'] : Array.isArray(s['anyOf']) ? s['anyOf'] : undefined
  const variants = variantsOf(ctx.root, s)
  if (variants && rawVariants) {
    const chosen = pickVariant(variants, value)
    return (
      <div className="flex flex-col gap-2">
        <FieldShell
          name={props.name}
          path={path}
          required={props.required}
          type={Array.isArray(s['oneOf']) ? 'oneOf' : 'anyOf'}
          description={s['description']}
        >
          <select
            aria-label={`Variante de ${pathName(path)}`}
            className={inputClass}
            value={value === undefined && !props.required ? '' : String(chosen)}
            onChange={(e) =>
              ctx.set(path, e.target.value === '' ? undefined : initialValue(ctx.root, variants[Number(e.target.value)]))
            }
          >
            {!props.required && <option value="">(não enviar)</option>}
            {variants.map((v, i) => (
              <option key={i} value={i}>
                {variantLabel(rawVariants[i], v, i)}
              </option>
            ))}
          </select>
        </FieldShell>
        {(value !== undefined || props.required) && (
          <Node
            ctx={ctx}
            raw={{ ...variants[chosen], description: undefined }}
            path={path}
            depth={depth + 1}
            required
            {...(fieldKind(variants[chosen]!) === 'object' ? {} : { name: props.name })}
          />
        )}
      </div>
    )
  }

  const kind = fieldKind(s)
  if (kind === 'object') return <ObjectNode {...props} schema={s} value={value} />
  if (kind === 'array') return <ArrayNode {...props} schema={s} value={value} />
  // Item simples de uma lista: só o controle, o índice já está ao lado.
  if (typeof path.at(-1) === 'number' && props.name === undefined)
    return <Scalar ctx={ctx} schema={s} path={path} value={value} required={props.required} />
  return (
    <FieldShell name={props.name} path={path} required={props.required} type={typeLabel(ctx.root, s)} description={s['description']}>
      <Scalar ctx={ctx} schema={s} path={path} value={value} required={props.required} />
    </FieldShell>
  )
}

function ObjectNode(props: {
  ctx: Ctx
  schema: Schema
  value: unknown
  path: FormPath
  depth: number
  required: boolean
  name?: string
}) {
  const { ctx, schema: s, path, depth } = props
  const properties = (s['properties'] ?? {}) as Schema
  const required = new Set(Array.isArray(s['required']) ? (s['required'] as string[]) : [])
  const extras = extraKeys(s, props.value)
  const absent = props.value === undefined
  const fields = (
    <>
      {Object.entries(properties).map(([name, child]) => (
        <Node key={name} ctx={ctx} raw={child} path={[...path, name]} depth={depth + 1} required={required.has(name)} name={name} />
      ))}
      {Object.keys(properties).length === 0 && <p className="text-muted">Objeto sem propriedades no schema: edite no JSON.</p>}
      {extras.length > 0 && (
        <p className="text-muted">
          Fora do schema (ficam no corpo, edite no JSON): <span className="font-mono">{extras.join(', ')}</span>
        </p>
      )}
    </>
  )
  // A raiz não ganha moldura: os campos do corpo ficam direto no formulário.
  if (path.length === 0 || props.name === undefined) return fields
  if (absent && !props.required)
    return (
      <AddButton
        label={`Adicionar ${props.name}`}
        hint={typeof s['description'] === 'string' ? s['description'] : undefined}
        onClick={() => ctx.set(path, initialValue(ctx.root, s))}
      >
        {props.name} <span className="text-muted">(objeto)</span>
      </AddButton>
    )
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-border-subtle p-2">
      <legend className="flex items-center gap-1 px-1">
        <FieldTitle name={props.name} required={props.required} type="object" />
        {!props.required && (
          <IconButton label={`Tirar ${pathName(path)} do corpo`} onClick={() => ctx.set(path, undefined)}>
            <Trash2 {...icon} />
          </IconButton>
        )}
      </legend>
      {typeof s['description'] === 'string' && <p className="-mt-1 text-muted">{s['description']}</p>}
      {fields}
    </fieldset>
  )
}

function ArrayNode(props: {
  ctx: Ctx
  schema: Schema
  value: unknown
  path: FormPath
  depth: number
  required: boolean
  name?: string
}) {
  const { ctx, schema: s, path, depth } = props
  const items = Array.isArray(props.value) ? props.value : []
  const itemSchema = s['items']
  const name = props.name ?? pathName(path)
  const add = () => ctx.set([...path, items.length], initialValue(ctx.root, itemSchema))
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-border-subtle p-2">
      <legend className="flex items-center gap-1 px-1">
        <FieldTitle name={name} required={props.required} type={typeLabel(ctx.root, s)} />
        {props.value !== undefined && !props.required && (
          <IconButton label={`Tirar ${pathName(path)} do corpo`} onClick={() => ctx.set(path, undefined)}>
            <Trash2 {...icon} />
          </IconButton>
        )}
      </legend>
      {typeof s['description'] === 'string' && <p className="-mt-1 text-muted">{s['description']}</p>}
      {items.map((_, i) => (
        <div key={i} className="flex items-start gap-1">
          <span className="mt-1.5 w-6 shrink-0 text-right font-mono text-[10px] text-muted">{i}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Node ctx={ctx} raw={itemSchema} path={[...path, i]} depth={depth + 1} required />
          </div>
          <IconButton label={`Remover o item ${i} de ${name}`} onClick={() => ctx.set([...path, i], undefined)}>
            <Trash2 {...icon} />
          </IconButton>
        </div>
      ))}
      <AddButton label={`Adicionar item em ${name}`} onClick={add}>
        item
      </AddButton>
    </fieldset>
  )
}

/** Controle de um valor simples: seletor (enum, booleano), número, data ou texto. */
function Scalar(props: { ctx: Ctx; schema: Schema; path: FormPath; value: unknown; required: boolean }) {
  const { ctx, schema: s, path, value, required } = props
  const label = pathName(path)
  const kind = fieldKind(s)
  const optional = !required
  // Opcional vazio sai do corpo; obrigatório vazio fica como "" (o JSON e a validação mostram).
  const clear = () => ctx.set(path, optional ? undefined : '')

  if (kind === 'enum' || kind === 'boolean') {
    const values = kind === 'enum' ? enumValues(s)! : [true, false]
    const options = [...values, ...(isNullable(s) ? [null] : [])]
    const current = value === undefined ? '' : enumKey(value)
    const known = options.some((v) => enumKey(v) === current)
    return (
      <select
        aria-label={label}
        className={inputClass}
        value={current}
        onChange={(e) => ctx.set(path, e.target.value === '' ? undefined : JSON.parse(e.target.value))}
      >
        {(optional || value === undefined) && <option value="">{optional ? '(não enviar)' : '(escolha)'}</option>}
        {!known && value !== undefined && <option value={current}>{String(typeof value === 'string' ? value : current)} (fora do schema)</option>}
        {options.map((v) => (
          <option key={enumKey(v)} value={enumKey(v)}>
            {typeof v === 'string' ? v : enumKey(v)}
          </option>
        ))}
      </select>
    )
  }

  if (kind === 'number' || kind === 'integer') {
    return (
      <input
        aria-label={label}
        className={inputClass}
        inputMode={kind === 'integer' ? 'numeric' : 'decimal'}
        placeholder={placeholder(s)}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => {
          const next = parseNumberInput(e.target.value, kind === 'integer')
          if (next === undefined) clear()
          else ctx.set(path, next)
        }}
        spellCheck={false}
      />
    )
  }

  if (kind === 'null') return <span className="font-mono text-muted">null</span>

  if (kind === 'any') {
    // Sem tipo: o texto vira JSON quando dá (número, objeto, true) e texto quando não.
    const text = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
    return (
      <input
        aria-label={label}
        className={inputClass}
        placeholder="valor ou JSON"
        value={text}
        onChange={(e) => {
          if (!e.target.value) return clear()
          try {
            ctx.set(path, JSON.parse(e.target.value))
          } catch {
            ctx.set(path, e.target.value)
          }
        }}
        spellCheck={false}
      />
    )
  }

  const format = typeof s['format'] === 'string' ? s['format'] : ''
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  const long = typeof s['maxLength'] === 'number' ? s['maxLength'] > 200 : false
  const common = {
    'aria-label': label,
    className: cx(inputClass, long && 'h-auto py-1'),
    placeholder: placeholder(s),
    value: text,
    spellCheck: false,
    onChange: (e: { target: { value: string } }) => (e.target.value === '' ? clear() : ctx.set(path, e.target.value))
  }
  if (long) return <textarea rows={3} {...common} />
  return (
    <input
      {...common}
      // Data pura usa o seletor do sistema; {{VAR}} digitado continua possível nos outros formatos.
      type={format === 'date' && !text.startsWith('{{') ? 'date' : format === 'email' ? 'email' : 'text'}
    />
  )
}

function placeholder(s: Schema): string | undefined {
  if ('default' in s) return `padrão: ${JSON.stringify(s['default'])}`
  if (Array.isArray(s['examples']) && s['examples'].length) return `ex.: ${typeof s['examples'][0] === 'string' ? s['examples'][0] : JSON.stringify(s['examples'][0])}`
  if (typeof s['format'] === 'string')
    return { 'date-time': '2026-01-31T12:00:00Z', date: 'AAAA-MM-DD', uuid: '00000000-0000-0000-0000-000000000000', email: 'nome@exemplo.com', uri: 'https://' }[s['format']]
  if (typeof s['pattern'] === 'string') return s['pattern']
  return undefined
}

function FieldTitle(props: { name?: string; required: boolean; type: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      {props.name !== undefined && <span className="truncate font-mono text-fg">{props.name}</span>}
      {props.required && (
        <span className="text-danger" title="Obrigatório" aria-label="obrigatório">
          *
        </span>
      )}
      <span className="shrink-0 text-[10px] text-muted">{props.type}</span>
    </span>
  )
}

function FieldShell(props: {
  name?: string
  path: FormPath
  required: boolean
  type: string
  description: unknown
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <FieldTitle name={props.name ?? (props.path.length ? undefined : 'corpo')} required={props.required} type={props.type} />
      {props.children}
      {typeof props.description === 'string' && <p className="text-[11px] text-muted">{props.description}</p>}
    </div>
  )
}

function AddButton(props: { label: string; hint?: string | undefined; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.hint}
      onClick={props.onClick}
      className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-muted hover:bg-elevated hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Plus {...icon} /> {props.children}
    </button>
  )
}
