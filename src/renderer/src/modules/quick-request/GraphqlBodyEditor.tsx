import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react'
import type { HttpResult } from '@shared/ipc'
import { Badge, Button, CodeEditor, cx, ErrorNotice, ResizablePane } from '../../design-system'
import { INTROSPECTION_QUERY, graphqlBody, operationNames, parseIntrospection, userTypes, type GqlField, type GqlSchema, type GqlType } from './graphql'
import type { GraphqlEditorHandle, MonacoGraphql } from './monaco-graphql'

let loading: Promise<MonacoGraphql> | null = null
/** O Monaco só carrega quando o corpo GraphQL é aberto. */
const loadMonaco = () => (loading ??= import('./monaco-graphql').then((m) => m.monacoGraphql))

/** Schemas já lidos nesta sessão, por conector e URL: trocar de aba não refaz a introspecção. */
const cache = new Map<string, GqlSchema>()

export interface GraphqlValue {
  query: string
  variables: string
  operationName?: string
}

/**
 * Corpo GraphQL do Quick Request: a consulta (Monaco com realce e autocomplete pelo schema),
 * as variáveis em JSON, a operação a rodar e o explorer do schema lido por introspecção. O
 * corpo da aba vira o JSON { query, variables, operationName } a cada edição.
 */
export default function GraphqlBodyEditor(props: {
  value: GraphqlValue
  /** Chave do schema em cache (conector + URL). */
  schemaKey: string
  onChange: (value: GraphqlValue, body: string) => void
  onRun: () => void
  /** Manda a consulta de introspecção pelo mesmo caminho do envio (auth do conector, ambiente). */
  introspect: (body: string) => Promise<HttpResult>
}) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<GraphqlEditorHandle | null>(null)
  const [ready, setReady] = useState(false)
  const [schema, setSchema] = useState<GqlSchema | null>(() => cache.get(props.schemaKey) ?? null)
  const [loadingSchema, setLoadingSchema] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef({ props, schema })
  latest.current = { props, schema }

  const change = (patch: Partial<GraphqlValue>) => {
    const next = { ...latest.current.props.value, ...patch }
    latest.current.props.onChange(next, graphqlBody(next.query, next.variables, next.operationName))
  }

  useEffect(() => {
    let disposed = false
    loadMonaco()
      .then((m) => {
        if (disposed || !host.current) return
        editor.current = m.create(host.current, {
          value: props.value.query,
          schema: () => latest.current.schema,
          onChange: (query) => change({ query }),
          onRun: () => latest.current.props.onRun()
        })
        setReady(true)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      editor.current?.dispose()
      editor.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (editor.current && editor.current.value() !== props.value.query) editor.current.setValue(props.value.query)
  }, [props.value.query])

  useEffect(() => setSchema(cache.get(props.schemaKey) ?? null), [props.schemaKey])

  const fetchSchema = async () => {
    setLoadingSchema(true)
    setError(null)
    try {
      const result = await props.introspect(JSON.stringify({ query: INTROSPECTION_QUERY, operationName: 'IntrospectionQuery' }))
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (result.response.status >= 400) throw new Error(`HTTP ${result.response.status} na introspecção`)
      let json: unknown
      try {
        json = JSON.parse(result.response.body)
      } catch {
        throw new Error('a resposta da introspecção não é JSON')
      }
      const parsed = parseIntrospection(json)
      cache.set(props.schemaKey, parsed)
      setSchema(parsed)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoadingSchema(false)
    }
  }

  const operations = operationNames(props.value.query)
  const variablesInvalid = useMemo(() => {
    if (!props.value.variables.trim()) return false
    try {
      const v: unknown = JSON.parse(props.value.variables)
      return !v || typeof v !== 'object' || Array.isArray(v)
    } catch {
      return true
    }
  }, [props.value.variables])

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" aria-label="Corpo GraphQL" role="group">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-2 py-1 text-xs text-muted">
          <span>Consulta</span>
          {operations.length > 1 && (
            <label className="ml-auto flex items-center gap-1.5">
              Operação
              <select
                aria-label="Operação a rodar"
                className="h-6 rounded border border-border bg-elevated px-1 text-xs text-fg"
                value={props.value.operationName ?? ''}
                onChange={(e) => change({ ...(e.target.value ? { operationName: e.target.value } : { operationName: undefined }) })}
              >
                <option value="">(a primeira)</option>
                {operations.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div ref={host} data-editor={ready ? 'monaco' : 'loading'} className={ready ? 'min-h-12 flex-1 overflow-hidden' : 'hidden'} />
        {!ready && (
          <CodeEditor
            ariaLabel="Consulta GraphQL"
            language="text"
            value={props.value.query}
            onChange={(query) => change({ query })}
            placeholder="query { ... }"
          />
        )}
        <div className="flex h-24 shrink-0 flex-col border-t border-border-subtle">
          <CodeEditor
            ariaLabel="Variáveis GraphQL"
            language="json"
            validate
            value={props.value.variables}
            onChange={(variables) => change({ variables })}
            placeholder='{ "id": "1" }'
            toolbar={
              <>
                <span>Variáveis (JSON)</span>
                {variablesInvalid && <span className="text-danger">precisam ser um objeto JSON</span>}
              </>
            }
          />
        </div>
      </div>
      <SchemaExplorer
        schema={schema}
        loading={loadingSchema}
        error={error}
        onFetch={() => void fetchSchema()}
        onInsert={(text) => (editor.current ? editor.current.insert(text) : change({ query: `${props.value.query}${text}` }))}
      />
    </div>
  )
}

/** Explorer do schema: as raízes e os tipos, campo a campo, com busca; clicar num campo insere no cursor. */
function SchemaExplorer(props: { schema: GqlSchema | null; loading: boolean; error: string | null; onFetch: () => void; onInsert: (text: string) => void }) {
  const { schema } = props
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  const roots = schema ? [schema.query, schema.mutation, schema.subscription].filter((n): n is string => !!n) : []
  const others = schema ? userTypes(schema).filter((t) => !roots.includes(t.name)) : []
  const q = filter.trim().toLowerCase()
  const matches = (t: GqlType) => !q || t.name.toLowerCase().includes(q) || t.fields.some((f) => f.name.toLowerCase().includes(q))

  const insertField = (f: GqlField) => {
    const t = schema?.types.get(f.named)
    const nested = t && (t.kind === 'OBJECT' || t.kind === 'INTERFACE' || t.kind === 'UNION')
    const args = f.args.filter((a) => a.type.endsWith('!')).map((a) => `${a.name}: `)
    props.onInsert(`${f.name}${args.length ? `(${args.join(', ')})` : ''}${nested ? ' {\n  \n}' : ''}`)
  }

  const typeBlock = (t: GqlType, root: boolean) => {
    const isOpen = open.has(t.name) || (!!q && t.fields.some((f) => f.name.toLowerCase().includes(q)))
    return (
      <li key={t.name}>
        <button type="button" className="flex w-full items-center gap-1 px-2 py-0.5 text-left hover:bg-elevated" aria-expanded={isOpen} onClick={() => toggle(t.name)}>
          {isOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          <span className={cx('font-mono', root ? 'text-fg' : 'text-muted')}>{t.name}</span>
          <span className="ml-auto text-[10px] text-faint">{t.kind === 'INPUT_OBJECT' ? 'input' : t.kind.toLowerCase()}</span>
        </button>
        {isOpen && (
          <ul aria-label={`Campos de ${t.name}`} className="pl-5">
            {t.kind === 'ENUM' &&
              t.values.map((v) => (
                <li key={v} className="px-2 font-mono text-muted">
                  {v}
                </li>
              ))}
            {t.fields
              .filter((f) => !q || t.name.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
              .map((f) => (
                <li key={f.name} className="flex items-baseline gap-1 px-2" title={[f.description, f.deprecated && `Obsoleto: ${f.deprecated}`].filter(Boolean).join('\n')}>
                  {t.kind === 'INPUT_OBJECT' ? (
                    <span className="font-mono text-fg">{f.name}</span>
                  ) : (
                    <button type="button" className={cx('font-mono hover:underline', f.deprecated ? 'text-faint line-through' : 'text-fg')} onClick={() => insertField(f)}>
                      {f.name}
                    </button>
                  )}
                  {f.args.length > 0 && <span className="text-faint">({f.args.map((a) => a.name).join(', ')})</span>}
                  <button type="button" className="ml-auto truncate font-mono text-accent hover:underline" onClick={() => schema?.types.has(f.named) && toggle(f.named)}>
                    {f.type}
                  </button>
                </li>
              ))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <ResizablePane
      as="aside"
      id="quick.graphql-schema"
      edge="left"
      label="Largura do schema GraphQL"
      defaultSize={288}
      min={200}
      max={640}
      className="flex flex-col border-l border-border-subtle text-xs"
      aria-label="Schema GraphQL"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-2 py-1">
        <span className="text-muted">Schema</span>
        {schema && <Badge tone="neutral">{userTypes(schema).length} tipos</Badge>}
        <Button size="sm" variant="ghost" className="ml-auto" icon={<RefreshCw size={12} aria-hidden />} disabled={props.loading} onClick={props.onFetch}>
          {props.loading ? 'Buscando…' : schema ? 'Atualizar' : 'Buscar schema'}
        </Button>
      </div>
      {props.error && (
        <div className="p-2">
          <ErrorNotice compact title="Introspecção falhou" code="GRAPHQL_INTROSPECTION" message={props.error} hint="Confira a URL, a auth e se o servidor permite introspecção." />
        </div>
      )}
      {!schema ? (
        <p className="p-3 text-muted">
          <strong className="text-fg">Buscar schema</strong> manda a consulta de introspecção para a URL da aba, com a auth do conector, e liga o
          autocomplete e o explorer.
        </p>
      ) : (
        <>
          <label className="flex shrink-0 items-center gap-1.5 border-b border-border-subtle px-2 py-1">
            <Search size={12} aria-hidden className="text-muted" />
            <input aria-label="Buscar no schema" className="min-w-0 flex-1 bg-transparent text-xs outline-none" placeholder="Tipo ou campo" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          <ul className="min-h-0 flex-1 overflow-auto py-1" aria-label="Tipos do schema">
            {roots.map((n) => schema.types.get(n)).filter((t): t is GqlType => !!t && matches(t)).map((t) => typeBlock(t, true))}
            {others.filter(matches).map((t) => typeBlock(t, false))}
          </ul>
        </>
      )}
    </ResizablePane>
  )
}
