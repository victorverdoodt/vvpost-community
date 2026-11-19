import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { BookOpen, Check, ChevronRight, FolderOpen, FolderTree, Network, Plus, RefreshCw, TriangleAlert, X } from 'lucide-react'
import type {
  BodyValidation,
  ConnectorRegistry,
  RegistryConnector,
  RegistryEndpoint,
  WorkspaceResult
} from '@shared/ipc'
import {
  Badge,
  Button,
  CodeEditor,
  cx,
  EmptyState,
  Field,
  IconButton,
  InheritanceBadge,
  InspectorPanel,
  InspectorSection,
  MethodBadge,
  table,
  Tabs,
  useContextMenu,
  useMenuCommands,
  DockablePane,
  type ContextMenuEntries
} from '../../design-system'
import { navigate, useNavigation } from '../../lib/navigate'
import { useCatalogMenus } from './menus'
import { WORKSPACE_CHANGED } from '../../panels/useWorkspace'
import { Markdown, MermaidDiagram } from '../../design-system/content/Markdown'
import { ConnectorEditor, impactOf, type ConnectorField } from './editor/ConnectorEditor'
import { EndpointSchemaEditor } from './editor/EndpointSchemaEditor'
import { openDocs } from '../docs/open'
import { AiReviewBanner } from './AiReview'
import { LintPanel } from './LintPanel'

type Tab = 'hierarchy' | 'docs' | 'edit'

/**
 * Connectors: Connector Registry e Living Documentation: a árvore de herança dos
 * conectores do workspace, de onde vem cada valor herdado e a documentação viva de
 * cada conector (Markdown e Mermaid do *.connector.vvpost.md, diagramas gerados,
 * campos do bodySchema e os corpos do conector conferidos com ele).
 */
export default function ConnectorsModule() {
  const [result, setResult] = useState<WorkspaceResult<ConnectorRegistry | null> | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [tab, setTab] = useState<Tab>('hierarchy')
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  /** Endpoint escolhido na árvore: a aba Documentação rola até ele. */
  const [focusEndpoint, setFocusEndpoint] = useState<string | null>(null)
  /** Ir à definição: o campo que o editor do conector de origem abre. */
  const [focusField, setFocusField] = useState<ConnectorField | undefined>(undefined)

  /** Cada leitura do catálogo: o painel do lint relê junto. */
  const [loads, setLoads] = useState(0)

  const reload = useCallback(() => {
    void window.vvpost.getConnectorRegistry().then((r) => {
      setResult(r)
      setLoads((n) => n + 1)
    })
  }, [])

  // Relê ao abrir e quando a janela volta ao foco (arquivos editados fora do app).
  useEffect(() => {
    reload()
    window.addEventListener('focus', reload)
    window.addEventListener(WORKSPACE_CHANGED, reload)
    return () => {
      window.removeEventListener('focus', reload)
      window.removeEventListener(WORKSPACE_CHANGED, reload)
    }
  }, [reload])

  const registry = result?.ok ? result.value : null
  const byId = useMemo(() => new Map(registry?.connectors.map((c) => [c.id, c])), [registry])
  const selected = byId.get(selectedId) ?? registry?.connectors[0] ?? null

  const open = () =>
    void window.vvpost.openWorkspace().then((r) => {
      if (!r.ok) setResult(r)
      else if (r.value) {
        reload()
        window.dispatchEvent(new Event(WORKSPACE_CHANGED))
      }
    })

  const ids = registry?.connectors.map((c) => c.id) ?? []

  useEffect(() => {
    if (!focusEndpoint || tab !== 'docs') return
    const frame = requestAnimationFrame(() => {
      document.getElementById(`endpoint-${focusEndpoint}`)?.scrollIntoView({ block: 'start' })
      setFocusEndpoint(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [focusEndpoint, tab, selectedId])

  const selectEndpoint = (connectorId: string, endpointId: string) => {
    setSelectedId(connectorId)
    setTab('docs')
    setFocusEndpoint(endpointId)
  }

  // "Abrir o conector no Catálogo" (Quick Request, Git): seleciona o conector ou o endpoint.
  useNavigation('catalog', (t) => {
    setCreating(false)
    if (t.endpointId) selectEndpoint(t.connectorId, t.endpointId)
    else {
      setSelectedId(t.connectorId)
      setTab('hierarchy')
    }
  })

  const menus = useCatalogMenus({
    connectors: registry?.connectors ?? [],
    reload,
    onSelect: (id) => {
      setSelectedId(id)
      setTab('hierarchy')
    },
    onEdit: (id) => {
      setCreating(false)
      setSelectedId(id)
      setTab('edit')
    },
    onCreate: () => setCreating(true)
  })
  // Na paleta: as ações do conector selecionado.
  useMenuCommands(
    'Catálogo',
    selected && !creating ? menus.connectorEntries(selected).map((e) => (e && typeof e === 'object' && !('type' in e) ? { ...e, label: `${selected.name}: ${e.label}` } : e)) : []
  )

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 text-xs text-muted">
          {!registry ? (
            <>
              <Button size="sm" icon={<FolderOpen size={14} aria-hidden />} onClick={open}>
                Abrir workspace…
              </Button>
              {result && !result.ok && <span className="text-danger">{result.message}</span>}
            </>
          ) : (
            <>
              <Network size={14} className="text-accent" aria-hidden />
              <span>
                {registry.connectors.length} {registry.connectors.length === 1 ? 'conector' : 'conectores'}
              </span>
              {registry.issues.length > 0 && (
                <Badge tone="warning">
                  <TriangleAlert size={11} aria-hidden />
                  {registry.issues.length} {registry.issues.length === 1 ? 'aviso' : 'avisos'}
                </Badge>
              )}
              <span className="flex-1" />
              <Button size="sm" icon={<BookOpen size={14} aria-hidden />} onClick={() => openDocs({ kind: 'project' })}>
                Documentação do projeto
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<Plus size={14} aria-hidden />}
                onClick={() => setCreating(true)}
              >
                Novo conector
              </Button>
              <IconButton label="Recarregar" onClick={reload}>
                <RefreshCw size={14} aria-hidden />
              </IconButton>
            </>
          )}
        </div>
        {registry && (
          <AiReviewBanner
            onOpenConnector={(id) => {
              setCreating(false)
              setSelectedId(id)
              setTab('hierarchy')
            }}
            onApproved={reload}
          />
        )}

        {registry && creating ? (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <ConnectorEditor
              connectorId={null}
              connectorIds={ids}
              onCancel={() => setCreating(false)}
              onSaved={(id) => {
                setCreating(false)
                setSelectedId(id)
                setTab('hierarchy')
                reload()
              }}
            />
          </div>
        ) : !registry ? (
          <EmptyState
            icon={<Network size={20} aria-hidden />}
            title="Nenhum workspace aberto"
            description="Abra o workspace para ver o catálogo de conectores e a documentação de cada um."
          />
        ) : registry.connectors.length === 0 ? (
          <EmptyState
            icon={<Network size={20} aria-hidden />}
            title="Nenhum conector no workspace"
            description="Conectores são arquivos *.connector.vvpost.json; importe do Postman ou crie um."
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            <DockablePane
              as="nav"
              id="catalog.tree"
              title="Conectores"
              dockLabel="a hierarquia de conectores"
              inspector="connectors"
              label="Largura da hierarquia de conectores"
              defaultSize={256}
              min={180}
              max={560}
              className="flex flex-col gap-2 overflow-auto border-r border-border-subtle p-2 text-xs"
              aria-label="Hierarquia de conectores"
            >
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filtrar conectores e endpoints"
                aria-label="Filtrar conectores e endpoints"
                className="h-7 border px-2"
              />
              <ConnectorTree
                connectors={registry.connectors}
                projectName={registry.dir.split(/[\\/]/).filter(Boolean).pop() ?? 'Projeto'}
                dir={registry.dir}
                filter={filter}
                selectedId={selected?.id ?? ''}
                onSelect={setSelectedId}
                onSelectEndpoint={selectEndpoint}
                menus={menus}
              />
            </DockablePane>
            {selected && (
              <section className="flex min-w-0 flex-1 flex-col" aria-label={`Conector ${selected.name}`}>
                <ConnectorHeader connector={selected} byId={byId} onSelect={setSelectedId} />
                <Tabs
                  label="Visões do conector"
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { id: 'hierarchy', label: 'Herança' },
                    { id: 'docs', label: 'Documentação' },
                    { id: 'edit', label: 'Editar' }
                  ]}
                />
                <div className="min-h-0 flex-1 overflow-auto p-4">
                  {tab === 'hierarchy' ? (
                    <HierarchyView
                      connector={selected}
                      byId={byId}
                      onGoTo={(id, field) => {
                        setSelectedId(id)
                        setFocusField(field)
                        setTab('edit')
                      }}
                    />
                  ) : tab === 'edit' ? (
                    <ConnectorEditor
                      key={selected.id}
                      connectorId={selected.id}
                      connectorIds={ids}
                      impact={impactOf(selected.id, registry?.connectors ?? [])}
                      {...(focusField && { focus: focusField })}
                      onCancel={() => setTab('hierarchy')}
                      onSaved={(id) => {
                        setSelectedId(id)
                        setTab('hierarchy')
                        reload()
                      }}
                    />
                  ) : (
                    <DocsView connector={selected} onChanged={reload} />
                  )}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
      <InspectorPanel id="connectors" title="Inspector">
        {selected ? (
          <ConnectorInspector connector={selected} byId={byId} onSelect={setSelectedId} />
        ) : (
          <EmptyState title="Nenhum conector selecionado" />
        )}
        {registry && (
          <LintPanel
            version={loads}
            onSelectEndpoint={(connectorId, endpointId) => {
              setCreating(false)
              if (endpointId) selectEndpoint(connectorId, endpointId)
              else {
                setSelectedId(connectorId)
                setTab('hierarchy')
              }
            }}
          />
        )}
        {registry && registry.issues.length > 0 && (
          <InspectorSection title="Avisos do workspace" count={registry.issues.length}>
            <div className="flex flex-col gap-1.5 text-xs">
              {registry.issues.map((i, n) => (
                <p key={n} className="text-warning">
                  <span className="font-mono">{i.file}</span>: {i.message}
                </p>
              ))}
            </div>
          </InspectorSection>
        )}
      </InspectorPanel>
      {menus.dialog}
    </div>
  )
}

/** Resumo do conector selecionado: identidade, cadeia de herança, filhos e endpoints. */
function ConnectorInspector(props: {
  connector: RegistryConnector
  byId: ReadonlyMap<string, RegistryConnector>
  onSelect: (id: string) => void
}) {
  const { connector: c, byId } = props
  return (
    <>
      <InspectorSection title="Conector">
        <Field label="Id">
          <span className="font-mono">{c.id}</span>
        </Field>
        <Field label="Versão">
          <span className="font-mono">v{c.version}</span>
        </Field>
        <Field label="Arquivo">
          <span className="font-mono" title={c.file}>
            {c.file}
          </span>
        </Field>
        <Field label="Herda de">{c.extends ? (byId.get(c.extends)?.name ?? c.extends) : 'nenhum (raiz)'}</Field>
        {c.error && (
          <Field label="Herança">
            <Badge tone="danger">quebrada</Badge>
          </Field>
        )}
      </InspectorSection>
      <InspectorSection title="Filhos" count={c.children.length}>
        {c.children.length === 0 ? (
          <p className="text-xs text-muted">Nenhum conector herda deste.</p>
        ) : (
          <div className="flex flex-col gap-0.5 text-xs">
            {c.children.map((id) => (
              <button
                key={id}
                type="button"
                className="truncate text-left text-cyan hover:underline"
                onClick={() => props.onSelect(id)}
              >
                {byId.get(id)?.name ?? id}
              </button>
            ))}
          </div>
        )}
      </InspectorSection>
      <InspectorSection title="Endpoints" count={c.endpoints.length}>
        {c.endpoints.length === 0 ? (
          <p className="text-xs text-muted">Este conector não declara endpoints.</p>
        ) : (
          <div className="flex flex-col gap-1 text-xs">
            {c.endpoints.map((e) => (
              <div key={e.id} className="flex items-center gap-2" title={e.name}>
                <MethodBadge method={e.method} className="w-14" />
                <span className="min-w-0 flex-1 truncate font-mono">{e.path}</span>
              </div>
            ))}
          </div>
        )}
      </InspectorSection>
    </>
  )
}

/**
 * Árvore pelo extends, com o projeto na raiz e os endpoints e as requests (cenários) de
 * cada conector. Conector com herança quebrada (pai ausente, ciclo) fica na raiz, marcado:
 * assim um ciclo nunca vira recursão infinita. O botão direito (ou Shift+F10) em qualquer
 * nível abre o menu com "Gerar documentação" daquele nível.
 */
function ConnectorTree(props: {
  connectors: RegistryConnector[]
  projectName: string
  dir: string
  filter: string
  selectedId: string
  onSelect: (id: string) => void
  onSelectEndpoint: (connectorId: string, endpointId: string) => void
  menus: ReturnType<typeof useCatalogMenus>
}) {
  const { connectors, selectedId, onSelect, menus } = props
  const ctx = useContextMenu()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const needle = props.filter.trim().toLowerCase()
  const children = new Map<string, RegistryConnector[]>()
  const roots: RegistryConnector[] = []
  const ids = new Set(connectors.map((c) => c.id))
  for (const c of connectors) {
    if (c.extends && !c.error && ids.has(c.extends)) children.set(c.extends, [...(children.get(c.extends) ?? []), c])
    else roots.push(c)
  }
  const endpointMatches = (e: RegistryEndpoint) =>
    !needle ||
    e.name.toLowerCase().includes(needle) ||
    e.path.toLowerCase().includes(needle) ||
    e.scenarios.some((s) => s.name.toLowerCase().includes(needle))
  const matches = (c: RegistryConnector): boolean =>
    !needle ||
    c.name.toLowerCase().includes(needle) ||
    c.id.includes(needle) ||
    c.endpoints.some(endpointMatches) ||
    (children.get(c.id) ?? []).some(matches)
  // Com filtro, tudo que bate fica aberto; sem filtro, vale o que o usuário expandiu.
  const isOpen = (key: string) => (needle ? true : expanded.has(key))
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const row = 'flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] py-1.5 pr-2 text-left'
  const indent = (depth: number) => ({ paddingLeft: `${0.25 + depth * 0.9}rem` })

  // O triângulo fica dentro da linha (um botão por linha): clique nele ou → e ← no teclado
  // abrem e fecham; o resto da linha seleciona, e o botão direito abre o menu.
  const disclosure = (key: string, show: boolean) =>
    show ? (
      <span
        aria-hidden
        onClick={(e) => {
          e.stopPropagation()
          toggle(key)
        }}
        className="flex h-5 w-4 shrink-0 cursor-pointer items-center justify-center text-faint hover:text-fg"
      >
        <ChevronRight size={12} className={cx('transition-transform', isOpen(key) && 'rotate-90')} />
      </span>
    ) : (
      <span className="w-4 shrink-0" aria-hidden />
    )
  const rowProps = (key: string | null, label: string, items: () => ContextMenuEntries) => {
    const menu = ctx.bind(label, items)
    return {
      ...menu,
      ...(key && { 'aria-expanded': isOpen(key) }),
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        menu.onKeyDown(e)
        if (!key || e.defaultPrevented) return
        if ((e.key === 'ArrowRight' && !isOpen(key)) || (e.key === 'ArrowLeft' && isOpen(key))) {
          e.preventDefault()
          toggle(key)
        }
      }
    }
  }

  const renderEndpoints = (c: RegistryConnector, depth: number) => (
    <ul aria-label={`Endpoints de ${c.name}`}>
      {c.endpoints.filter(endpointMatches).map((e) => {
        const key = `e:${c.id}/${e.id}`
        return (
          <li key={e.id}>
            <div style={indent(depth)}>
              <button
                type="button"
                onClick={() => props.onSelectEndpoint(c.id, e.id)}
                {...rowProps(e.scenarios.length ? key : null, `Endpoint ${e.name}`, () => menus.endpointEntries(c, e))}
                className={cx(row, 'text-muted hover:bg-elevated hover:text-fg')}
                title={`${e.method} ${e.path}`}
              >
                {disclosure(key, e.scenarios.length > 0)}
                <MethodBadge method={e.method} className="w-12" />
                <span className="truncate">{e.name}</span>
              </button>
            </div>
            {isOpen(key) && e.scenarios.length > 0 && (
              <ul aria-label={`Requests de ${e.name}`}>
                {e.scenarios.map((s) => (
                  <li key={s.id} style={indent(depth + 1)}>
                    <button
                      type="button"
                      onClick={() => props.onSelectEndpoint(c.id, e.id)}
                      {...ctx.bind(`Request ${s.name}`, () => menus.scenarioEntries(c, e, s))}
                      className={cx(row, 'text-muted hover:bg-elevated hover:text-fg')}
                    >
                      <span className="w-4 shrink-0" aria-hidden />
                      <span className="text-faint" aria-hidden>
                        ↳
                      </span>
                      <span className="truncate">{s.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )

  const render = (c: RegistryConnector, depth: number): ReactNode => {
    if (!matches(c)) return null
    const key = `c:${c.id}`
    return (
      <li key={c.id}>
        <div style={indent(depth)}>
          <button
            type="button"
            onClick={() => onSelect(c.id)}
            {...rowProps(c.endpoints.length ? key : null, `Conector ${c.name}`, () => menus.connectorEntries(c))}
            aria-current={c.id === selectedId ? 'true' : undefined}
            className={cx(row, c.id === selectedId ? 'bg-accent/15 text-fg' : 'text-muted hover:bg-elevated hover:text-fg')}
          >
            {disclosure(key, c.endpoints.length > 0)}
            {depth > 0 && <span className="text-faint">└</span>}
            <span className="truncate" title={`${c.name}
${c.id}`}>
              {c.name}
            </span>
            {c.error && (
              <Badge tone="danger" title={c.error}>
                erro
              </Badge>
            )}
            <span
              className={cx('ml-auto shrink-0', c.id === selectedId ? 'text-muted' : 'text-faint')}
              title={`${c.endpoints.length} endpoints`}
            >
              {c.endpoints.length}
            </span>
          </button>
        </div>
        {isOpen(key) && c.endpoints.length > 0 && renderEndpoints(c, depth + 1)}
        {(children.get(c.id)?.length ?? 0) > 0 && <ul>{children.get(c.id)!.map((k) => render(k, depth + 1))}</ul>}
      </li>
    )
  }
  return (
    <>
      <button
        type="button"
        onClick={() => openDocs({ kind: 'project' })}
        {...ctx.bind(`Projeto ${props.projectName}`, () => menus.projectEntries(props.dir))}
        title="Gerar documentação do projeto (botão direito em qualquer nível para mais)"
        className={cx(row, 'pl-1 font-medium text-fg hover:bg-elevated')}
      >
        <FolderTree size={14} className="shrink-0 text-accent" aria-hidden />
        <span className="truncate">{props.projectName}</span>
        <BookOpen size={12} className="ml-auto shrink-0 text-faint" aria-hidden />
      </button>
      <ul className="flex flex-col gap-0.5">{roots.map((c) => render(c, 0))}</ul>
      {ctx.menu}
    </>
  )
}

function ConnectorHeader(props: {
  connector: RegistryConnector
  byId: ReadonlyMap<string, RegistryConnector>
  onSelect: (id: string) => void
}) {
  const { connector: c, byId } = props
  return (
    <header className="flex shrink-0 flex-col gap-1 px-4 pt-3 pb-2">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-sm font-semibold">{c.name}</h2>
        <span className="font-mono text-[11px] text-muted">v{c.version}</span>
        <span className="ml-auto flex items-center gap-2 self-center">
          {c.source && (
            <Button
              size="sm"
              icon={<RefreshCw size={14} aria-hidden />}
              title={`Lê de novo ${c.source.location}${c.source.version ? ` (importada na versão ${c.source.version})` : ''} e mostra o que mudou antes de gravar`}
              onClick={() => navigate({ module: 'import-export', reimportConnectorId: c.id })}
            >
              Reimportar a spec
            </Button>
          )}
          <Button size="sm" icon={<BookOpen size={14} aria-hidden />} onClick={() => openDocs({ kind: 'connector', connectorId: c.id })}>
            Gerar documentação
          </Button>
        </span>
      </div>
      <nav className="flex flex-wrap items-center gap-1 text-xs text-muted" aria-label="Cadeia de herança">
        {c.chain.map((id, i) => (
          <span key={id} className="flex items-center gap-1">
            {i > 0 && <span className="text-faint">→</span>}
            {id === c.id ? (
              <span className="text-fg">{c.name}</span>
            ) : (
              <button type="button" className="text-cyan hover:underline" onClick={() => props.onSelect(id)}>
                {byId.get(id)?.name ?? id}
              </button>
            )}
          </span>
        ))}
      </nav>
      {c.error && <p className="text-xs text-danger">Herança quebrada: {c.error}</p>}
    </header>
  )
}

function HierarchyView({
  connector: c,
  byId,
  onGoTo
}: {
  connector: RegistryConnector
  byId: ReadonlyMap<string, RegistryConnector>
  /** Ir à definição original: abre o editor do conector de origem no campo. */
  onGoTo: (id: string, field: ConnectorField) => void
}) {
  const name = (id: string) => byId.get(id)?.name ?? id
  const origin = (from: string, field?: ConnectorField, label?: string) =>
    from === c.id ? (
      <InheritanceBadge kind="local" />
    ) : (
      <span className="flex flex-wrap items-center gap-1">
        <InheritanceBadge kind="inherited" from={name(from)} />
        {field && byId.has(from) && (
          <button
            type="button"
            className="text-[11px] text-cyan hover:underline"
            aria-label={`Ir à definição de ${label} em ${name(from)}`}
            onClick={() => onGoTo(from, field)}
          >
            Ir à definição
          </button>
        )}
      </span>
    )
  const r = c.resolved

  return (
    <div className="flex flex-col gap-4">
      <MermaidDiagram source={c.diagrams.hierarchy} label={`Hierarquia de ${c.name}`} />
      {r ? (
        <table className={table.root} aria-label="Configuração efetiva">
          <thead className={table.head}>
            <tr>
              <th className={`${table.th} w-32`}>Campo</th>
              <th className={table.th}>Valor efetivo</th>
              <th className={`${table.th} w-64`}>Origem</th>
            </tr>
          </thead>
          <tbody>
            <Row label="URL base">
              {r.baseUrl ? (
                <code>{r.baseUrl.value}</code>
              ) : (
                <span className="text-muted">nenhum conector da cadeia define</span>
              )}
              {r.baseUrl && origin(r.baseUrl.from, 'baseUrl', 'URL base')}
            </Row>
            <Row label="basePath">
              {r.basePath ? <code>{r.basePath}</code> : <span className="text-muted">—</span>}
              {c.own.basePath ? <Badge tone="accent">soma {c.own.basePath}</Badge> : <span />}
            </Row>
            {r.headers.length === 0 ? (
              <Row label="Headers">
                <span className="text-muted">nenhum</span>
                <span />
              </Row>
            ) : (
              r.headers.map((h, i) => (
                <Row key={h.name} label={i === 0 ? 'Headers' : ''}>
                  <code>
                    {h.name}: {h.value}
                  </code>
                  <span className="flex flex-wrap gap-1">
                    {h.overrides.length > 0 && h.from === c.id ? (
                      <InheritanceBadge kind="overridden" from={h.overrides.map(name).join(', ')} />
                    ) : (
                      <>
                        {origin(h.from, { header: h.name }, h.name)}
                        {h.overrides.length > 0 && (
                          <InheritanceBadge kind="overridden" from={h.overrides.map(name).join(', ')} />
                        )}
                      </>
                    )}
                  </span>
                </Row>
              ))
            )}
            <Row label="Auth">
              {r.auth ? r.auth.summary : r.authDisabledBy ? 'Desligada' : <span className="text-muted">nenhuma</span>}
              {r.auth ? origin(r.auth.from, 'auth', 'Auth') : r.authDisabledBy ? origin(r.authDisabledBy, 'auth', 'Auth') : <span />}
            </Row>
            <Row label="mTLS">
              {r.tlsFrom ? 'Certificado de cliente' : <span className="text-muted">nenhum</span>}
              {r.tlsFrom ? origin(r.tlsFrom, 'tls', 'mTLS') : <span />}
            </Row>
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-muted">Corrija o extends para ver a configuração efetiva.</p>
      )}
      <p className="text-xs text-muted">
        O filho sobrescreve headers pelo nome e troca auth e mTLS inteiros; o basePath acumula.
      </p>
    </div>
  )
}

function DocsView({ connector: c, onChanged }: { connector: RegistryConnector; onChanged: () => void }) {
  return (
    <article className="flex flex-col gap-5" aria-label={`Documentação de ${c.name}`}>
      {c.description && <Markdown source={c.description} />}
      {c.docs ? (
        c.docs.overview && <Markdown source={c.docs.overview} />
      ) : (
        <p className="text-xs text-muted">
          Sem documentação escrita. Crie{' '}
          <code>{c.file.replace(/\.connector\.vvpost\.json$/, '.connector.vvpost.md')}</code> ao lado do conector:
          Markdown com blocos ```mermaid, e um título terminado em {'{#id-do-endpoint}'} abre a seção daquele endpoint.
        </p>
      )}
      {c.diagrams.auth && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold">Autenticação</h3>
          <MermaidDiagram source={c.diagrams.auth} label={`Fluxo de autenticação de ${c.name}`} />
        </section>
      )}
      <section className="flex flex-col gap-3">
        <h3 className="text-[13px] font-semibold">Endpoints</h3>
        {c.endpoints.length === 0 && <p className="text-xs text-muted">Este conector não declara endpoints.</p>}
        {c.endpoints.map((e) => (
          <EndpointDoc key={e.id} connectorId={c.id} endpoint={e} onChanged={onChanged} />
        ))}
      </section>
    </article>
  )
}

function EndpointDoc({ connectorId, endpoint: e, onChanged }: { connectorId: string; endpoint: RegistryEndpoint; onChanged: () => void }) {
  const failing = e.checks.filter((k) => k.issues.length > 0)
  const [editingFields, setEditingFields] = useState(false)
  return (
    <section
      className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-panel p-3"
      aria-label={`Endpoint ${e.name}`}
      id={`endpoint-${e.id}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3">
        <MethodBadge method={e.method} />
        <span className="font-mono text-xs">{e.path}</span>
        <span className="text-xs text-muted">{e.name}</span>
        {e.bodySchema && (
          <Badge tone={failing.length ? 'warning' : 'success'} className="ml-auto">
            {failing.length ? <TriangleAlert size={11} aria-hidden /> : <Check size={11} aria-hidden />}
            {failing.length
              ? `${failing.length} ${failing.length === 1 ? 'corpo fora' : 'corpos fora'} do schema`
              : 'corpos de acordo com o schema'}
          </Badge>
        )}
        <IconButton
          label={`Gerar documentação de ${e.name}`}
          className={cx('self-center', !e.bodySchema && 'ml-auto')}
          onClick={() => openDocs({ kind: 'endpoint', connectorId, endpointId: e.id })}
        >
          <BookOpen size={14} aria-hidden />
        </IconButton>
      </div>
      {e.url && <code className="font-mono text-xs text-cyan">{e.url}</code>}
      {e.description && <Markdown source={e.description} />}
      {e.docs && <Markdown source={e.docs} />}
      {(e.headers.length > 0 || e.query.length > 0) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {e.headers.map((h) => (
            <Pair key={`h-${h.name}`} term={`header ${h.name}`} value={h.value} />
          ))}
          {e.query.map((q) => (
            <Pair key={`q-${q.name}`} term={`query ${q.name}`} value={q.value} />
          ))}
        </dl>
      )}
      {editingFields ? (
        <EndpointSchemaEditor
          connectorId={connectorId}
          endpointId={e.id}
          onClose={() => setEditingFields(false)}
          onSaved={() => {
            setEditingFields(false)
            onChanged()
          }}
        />
      ) : (
        e.method !== 'GET' &&
        e.method !== 'HEAD' && (
          <Button size="sm" variant="secondary" className="self-start" onClick={() => setEditingFields(true)}>
            {e.bodySchema ? 'Editar os campos do corpo' : 'Definir os campos do corpo'}
          </Button>
        )
      )}
      {!editingFields && e.fields.length > 0 && (
        <table className={table.root} aria-label={`Campos do corpo de ${e.name}`}>
          <thead className={table.head}>
            <tr>
              <th className={table.th}>Campo</th>
              <th className={table.th}>Tipo</th>
              <th className={table.th}>Obrigatório</th>
              <th className={table.th}>Descrição</th>
            </tr>
          </thead>
          <tbody>
            {e.fields.map((f) => (
              <tr key={f.path} className={table.row}>
                <td className={`${table.td} font-mono`}>{f.path}</td>
                <td className={`${table.td} font-mono text-muted`}>{f.values ? f.values.join(' | ') : f.type}</td>
                <td className={table.td}>{f.required ? 'sim' : ''}</td>
                <td className={table.td}>{f.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {e.checks.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs" aria-label={`Validação dos corpos de ${e.name}`}>
          {e.checks.map((k) => (
            <li key={k.source}>
              <span className={cx('inline-flex align-[-2px]', k.issues.length ? 'text-warning' : 'text-success')}>
                {k.issues.length ? (
                  <X size={12} aria-label="fora do schema" />
                ) : (
                  <Check size={12} aria-label="de acordo" />
                )}
              </span>{' '}
              {k.label}
              {k.issues.length > 0 && <IssueList issues={k.issues} />}
            </li>
          ))}
          {failing.some((k) => k.source !== 'body') && (
            <li className="text-muted">
              Cenários de erro costumam mandar corpo inválido de propósito: aqui é aviso, não falha.
            </li>
          )}
        </ul>
      )}
      {e.exampleChecks && (
        <ul className="flex flex-col gap-1 text-xs" aria-label={`Exemplos de resposta de ${e.name}`}>
          {e.exampleChecks.map((k) => (
            <li key={k.id}>
              <span className={cx('inline-flex align-[-2px]', k.issues.length ? 'text-danger' : 'text-success')}>
                {k.issues.length ? <X size={12} aria-label="fora do schema" /> : <Check size={12} aria-label="de acordo" />}
              </span>{' '}
              Exemplo {k.status}: {k.name}
              {k.issues.length > 0 && (
                <>
                  {' '}
                  <span className="text-muted">fora do schema dele; o vvpost validate reprova</span>
                  <IssueList issues={k.issues} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {e.bodySchema && <BodyTester connectorId={connectorId} endpoint={e} />}
    </section>
  )
}

/** Cola um corpo e confere com o bodySchema no main process (o mesmo validador dos cenários). */
function BodyTester({ connectorId, endpoint }: { connectorId: string; endpoint: RegistryEndpoint }) {
  const [body, setBody] = useState(endpoint.body ?? '{\n  \n}')
  const [result, setResult] = useState<BodyValidation | null>(null)
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted hover:text-fg">Validar um corpo com o schema</summary>
      <div className="mt-2 flex flex-col gap-2">
        <div className="flex h-36 overflow-hidden rounded-[var(--radius-control)] border border-border">
          <CodeEditor
            ariaLabel={`Corpo para validar em ${endpoint.name}`}
            language="json"
            value={body}
            onChange={(v) => {
              setBody(v)
              setResult(null)
            }}
          />
        </div>
        <div className="flex items-start gap-3">
          <Button
            size="sm"
            variant="primary"
            onClick={() => void window.vvpost.validateEndpointBody(connectorId, endpoint.id, body).then(setResult)}
          >
            Validar
          </Button>
          {result &&
            (result.ok ? (
              <span className="text-success" role="status">
                Corpo válido para o schema.
              </span>
            ) : 'message' in result ? (
              <span className="text-danger" role="status">
                {result.message}
              </span>
            ) : (
              <div role="status" className="text-warning">
                {result.issues.length} {result.issues.length === 1 ? 'problema' : 'problemas'}
                <IssueList issues={result.issues} />
              </div>
            ))}
        </div>
      </div>
    </details>
  )
}

function IssueList({ issues }: { issues: { path: string; message: string }[] }) {
  return (
    <ul className="mt-1 ml-4 list-disc text-muted">
      {issues.map((i, n) => (
        <li key={n}>
          <span className="font-mono">{i.path || '/'}</span> {i.message}
        </li>
      ))}
    </ul>
  )
}

function Row({ label, children }: { label: string; children: [ReactNode, ReactNode] }) {
  return (
    <tr className={table.row}>
      <td className={`${table.td} text-muted`}>{label}</td>
      <td className={`${table.td} font-mono break-all`}>{children[0]}</td>
      <td className={table.td}>{children[1]}</td>
    </tr>
  )
}

function Pair({ term, value }: { term: string; value: string }) {
  return (
    <>
      <dt className="font-mono text-muted">{term}</dt>
      <dd className="font-mono break-all">{value}</dd>
    </>
  )
}
