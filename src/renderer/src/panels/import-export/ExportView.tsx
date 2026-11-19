import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, FileUp, FolderOpen, Workflow } from 'lucide-react'
import type { ExportFormat, ExportOptions, ExportPreview, ExportSaveResult, ExportSelection } from '@shared/ipc'
import { Badge, Button, cx, EmptyState, MethodBadge, SegmentedControl, useToast } from '../../design-system'
import { WORKSPACE_CHANGED } from '../useWorkspace'
import { fieldClass } from './model'
import { ArchiveExport } from './ArchiveViews'

/** Endpoints marcados por conector. Conector sem endpoints entra marcado com o conjunto vazio. */
type Picked = Map<string, Set<string>>

const all = (options: ExportOptions): Picked =>
  new Map(options.connectors.map((c) => [c.id, new Set(c.endpoints.map((e) => e.id))]))

/** O .zip não é um formato do pacote: leva a pasta inteira, sem a seleção. */
type Format = ExportFormat | 'zip'

const FORMATS: { value: Format; label: string; title: string; noun: string; done: string; hint: string }[] = [
  {
    value: 'vvpost',
    label: 'Pacote do VVPost',
    title: 'Tudo, para outro projeto do VVPost: conectores, cenários, ambientes, fluxos e documentação',
    noun: 'pacote',
    done: 'Pacote exportado',
    hint: 'Segredos vão como __REQUIRED_SECRET__: quem importar preenche os valores na própria máquina.'
  },
  {
    value: 'postman',
    label: 'Postman',
    title: 'Coleção v2.1 (uma pasta por conector, com a auth) e um ambiente do Postman por ambiente',
    noun: 'coleção do Postman',
    done: 'Coleção do Postman exportada',
    hint: 'A auth vai como variáveis {{VAR}} e os segredos vão vazios nos ambientes do Postman. Cenários e fluxos ficam só no pacote.'
  },
  {
    value: 'openapi',
    label: 'OpenAPI',
    title: 'Spec OpenAPI 3.1 em JSON ou YAML: operações, bodySchema, exemplos, auth e servidores',
    noun: 'spec OpenAPI',
    done: 'Spec OpenAPI exportada',
    hint: 'A auth vira securitySchemes, sem valores; os servidores usam só variáveis que não são segredo. Cenários e fluxos ficam só no pacote.'
  },
  {
    value: 'zip',
    label: '.zip',
    title: 'A pasta do projeto ou do workspace inteiro, como está, num .vvpost.zip que o VVPost abre como workspace ou como projeto',
    noun: '.zip',
    done: 'Zip exportado',
    hint: ''
  }
]

/**
 * Exporta o projeto aberto como pacote do VVPost (.vvpost.bundle.json): o projeto
 * inteiro ou uma seleção de conectores, endpoints, ambientes e fluxos. A prévia vem
 * do main process, que monta o pacote de verdade (com os pais e os conectores dos
 * fluxos) e recusa se algum valor de segredo fosse sair.
 */
export function ExportView() {
  const [options, setOptions] = useState<ExportOptions | null | undefined>(undefined)
  const [picked, setPicked] = useState<Picked>(new Map())
  const [environments, setEnvironments] = useState<Set<string>>(new Set())
  const [flows, setFlows] = useState<Set<string>>(new Set())
  const [scenarios, setScenarios] = useState(true)
  const [docs, setDocs] = useState(true)
  const [format, setFormat] = useState<Format>('vvpost')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [outcome, setOutcome] = useState<ExportSaveResult | null>(null)
  const [busy, setBusy] = useState(false)
  const notify = useToast()

  const load = useCallback(async () => {
    const next = await window.vvpost.getExportOptions()
    setOptions(next)
    if (!next) return
    setPicked(all(next))
    setEnvironments(new Set(next.environments.map((e) => e.id)))
    setFlows(new Set(next.flows.map((f) => f.id)))
    setName((n) => n || next.name)
    setOutcome(null)
  }, [])

  useEffect(() => {
    void load()
    const reload = () => void load()
    window.addEventListener(WORKSPACE_CHANGED, reload)
    return () => window.removeEventListener(WORKSPACE_CHANGED, reload)
  }, [load])

  const selection = useMemo((): ExportSelection => {
    const flags: ExportSelection = { ...(format !== 'vvpost' && format !== 'zip' && { format }), ...(!scenarios && { scenarios: false }), ...(!docs && { docs: false }) }
    if (!options) return flags
    const whole =
      options.connectors.every((c) => picked.get(c.id)?.size === c.endpoints.length) &&
      options.environments.every((e) => environments.has(e.id)) &&
      options.flows.every((f) => flows.has(f.id))
    if (whole) return flags
    const connectors: string[] = []
    const endpoints: string[] = []
    for (const c of options.connectors) {
      const set = picked.get(c.id)
      if (!set) continue
      if (set.size === c.endpoints.length) connectors.push(c.id)
      else for (const e of set) endpoints.push(`${c.id}/${e}`)
    }
    return { ...flags, connectors, endpoints, environments: [...environments], flows: [...flows] }
  }, [options, picked, environments, flows, scenarios, docs, format])

  useEffect(() => {
    if (!options || format === 'zip') return
    let current = true
    const timer = setTimeout(() => {
      void window.vvpost.previewExport(selection).then((p) => current && setPreview(p))
    }, 150)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [options, selection, format])

  if (options === undefined) return null
  if (options === null) {
    return (
      <EmptyState
        icon={<FileUp size={20} aria-hidden />}
        title="Exportar pacote do VVPost"
        description="Abra um projeto para exportar conectores, endpoints, cenários, ambientes e fluxos num único arquivo .vvpost.bundle.json. Valores de segredo nunca vão no pacote."
      />
    )
  }

  const toggleConnector = (id: string) =>
    setPicked((prev) => {
      const next = new Map(prev)
      const c = options.connectors.find((x) => x.id === id)!
      if (next.has(id)) next.delete(id)
      else next.set(id, new Set(c.endpoints.map((e) => e.id)))
      return next
    })
  const toggleEndpoint = (connectorId: string, endpointId: string) =>
    setPicked((prev) => {
      const next = new Map(prev)
      const set = new Set(next.get(connectorId) ?? [])
      if (set.has(endpointId)) set.delete(endpointId)
      else set.add(endpointId)
      if (set.size) next.set(connectorId, set)
      else next.delete(connectorId)
      return next
    })
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }
  const setEverything = (on: boolean) => {
    setPicked(on ? all(options) : new Map())
    setEnvironments(new Set(on ? options.environments.map((e) => e.id) : []))
    setFlows(new Set(on ? options.flows.map((f) => f.id) : []))
  }

  const save = async () => {
    setBusy(true)
    try {
      const result = await window.vvpost.saveExport(selection, { name, description })
      if (!result.ok && result.reason === 'canceled') return
      setOutcome(result)
      if (result.ok) notify(kind.done, 'success')
    } catch (err) {
      notify((err as Error).message, 'danger')
    } finally {
      setBusy(false)
    }
  }

  const kind = FORMATS.find((f) => f.value === format)!
  const empty = preview?.ok && Object.values(preview.summary).every((n) => n === 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4">
        <h1 className="text-sm font-semibold">Exportar</h1>
        <SegmentedControl<Format>
          label="Formato da exportação"
          value={format}
          onChange={(next) => {
            setFormat(next)
            setOutcome(null)
          }}
          options={FORMATS.map(({ value, label, title }) => ({ value, label, title }))}
        />
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <FolderOpen size={14} aria-hidden />
          <span className="truncate font-mono">{options.dir}</span>
        </span>
        {format !== 'zip' && (
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEverything(true)}>
              Marcar tudo
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEverything(false)}>
              Limpar
            </Button>
          </span>
        )}
      </header>

      {format === 'zip' ? (
        <ArchiveExport name={name} />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
            <div className="flex flex-wrap gap-2 text-xs" aria-label="Resumo da exportação">
              {preview?.ok &&
                (
                  [
                    ['connectors', 'conectores'],
                    ['endpoints', 'endpoints'],
                    ['scenarios', 'cenários'],
                    ['environments', 'ambientes'],
                    ['flows', 'fluxos'],
                    ['docs', 'documentações']
                  ] as const
                )
                  // Cenários e fluxos só vão no pacote do VVPost.
                  .filter(([key]) => format === 'vvpost' || (key !== 'scenarios' && key !== 'flows'))
                  .map(([key, label]) => (
                  <span key={key} className="rounded-[var(--radius-control)] border border-border bg-panel px-2.5 py-1">
                    <span className="font-semibold text-fg">{preview.summary[key]}</span> <span className="text-muted">{label}</span>
                  </span>
                ))}
            </div>

            {preview && !preview.ok && (
              <div role="alert" className="rounded-[var(--radius-card)] border border-danger/40 px-3 py-2 text-xs whitespace-pre-line text-danger">
                {preview.message}
              </div>
            )}
            {preview?.ok && preview.warnings.length > 0 && (
              <details className="rounded-[var(--radius-card)] border border-warning/40 px-3 py-2 text-xs text-warning">
                <summary className="cursor-pointer font-medium">Avisos ({preview.warnings.length})</summary>
                <div className="mt-2 flex flex-col gap-1 text-muted">
                  {preview.warnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              </details>
            )}

            <Group title="Conectores" count={options.connectors.length}>
              {options.connectors.map((c) => (
                <ConnectorRow
                  key={c.id}
                  connector={c}
                  picked={picked.get(c.id)}
                  onToggle={() => toggleConnector(c.id)}
                  onToggleEndpoint={(e) => toggleEndpoint(c.id, e)}
                />
              ))}
            </Group>

            <Group title="Ambientes" count={options.environments.length}>
              {options.environments.map((e) => (
                <Check key={e.id} label={e.name} checked={environments.has(e.id)} onChange={() => setEnvironments((s) => toggle(s, e.id))}>
                  <span className="font-mono text-faint">{e.id}</span>
                  <span className="text-muted">{e.variables} variáveis</span>
                  {e.secrets > 0 && (
                    <Badge
                      tone="warning"
                      title={
                        format === 'postman'
                          ? 'Vão vazios no ambiente do Postman: o valor fica só na sua máquina'
                          : 'Vão como __REQUIRED_SECRET__: o valor fica só na sua máquina'
                      }
                    >
                      {e.secrets} segredo(s) sem valor
                    </Badge>
                  )}
                </Check>
              ))}
            </Group>

            <Group title={format === 'vvpost' ? 'Fluxos' : 'Fluxos (só os conectores que eles usam)'} count={options.flows.length}>
              {options.flows.map((f) => (
                <Check key={f.id} label={f.name} checked={flows.has(f.id)} onChange={() => setFlows((s) => toggle(s, f.id))}>
                  <Workflow size={13} aria-hidden className="text-muted" />
                  <span className="font-mono text-faint">{f.id}</span>
                  <span className="text-muted">{f.nodes} nós</span>
                  {f.connectors.length > 0 && (
                    <span className="truncate text-muted" title="Os conectores do fluxo entram junto no pacote">
                      usa {f.connectors.join(', ')}
                    </span>
                  )}
                </Check>
              ))}
            </Group>

            <section className="flex flex-col gap-2 text-xs" aria-label="Opções do pacote">
              <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{format === 'vvpost' ? 'Pacote' : 'Arquivo'}</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-muted">
                    {format === 'vvpost' ? 'Nome do pacote' : format === 'postman' ? 'Nome da coleção' : 'Título da API'}
                  </span>
                  <input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-medium text-muted">Descrição</span>
                  <input className={fieldClass} value={description} onChange={(e) => setDescription(e.target.value)} />
                </label>
              </div>
              {format === 'vvpost' && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={scenarios} onChange={(e) => setScenarios(e.target.checked)} />
                  Levar os cenários de teste dos endpoints
                </label>
              )}
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={docs} onChange={(e) => setDocs(e.target.checked)} />
                {format === 'vvpost' ? 'Levar a documentação Markdown dos conectores' : 'Levar a documentação Markdown dos conectores nas descrições'}
              </label>
            </section>
          </div>

          <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-2.5">
            {outcome?.ok && (
              <div className="text-xs text-success" role="status">
                {format === 'vvpost' ? 'Pacote salvo' : 'Salvo'} em <span className="font-mono">{outcome.path}</span>
                {outcome.files.length > 0 && <> e {outcome.files.length} ambiente(s) do Postman ao lado</>}
              </div>
            )}
            {outcome && !outcome.ok && outcome.reason === 'error' && (
              <div className="text-xs whitespace-pre-line text-danger" role="alert">
                {outcome.message}
              </div>
            )}
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted">{kind.hint}</span>
              <Button variant="primary" className="ml-auto" disabled={busy || !preview?.ok || empty} onClick={() => void save()}>
                Exportar {kind.noun}…
              </Button>
            </div>
          </footer>
        </>
      )}
    </div>
  )
}

function Group(props: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={props.title}>
      <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{props.title}</h2>
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-panel py-1">
        {props.count ? props.children : <p className="px-3 py-1.5 text-xs text-muted">Nenhum no projeto.</p>}
      </div>
    </section>
  )
}

function Check(props: { label: string; checked: boolean; onChange: () => void; indent?: number; children?: ReactNode }) {
  return (
    <label
      className="flex h-8 cursor-pointer items-center gap-2 pr-3 text-xs hover:bg-border/40"
      style={{ paddingLeft: `${12 + (props.indent ?? 0) * 20}px` }}
    >
      <input type="checkbox" checked={props.checked} onChange={props.onChange} aria-label={props.label} />
      <span className="truncate font-medium">{props.label}</span>
      <span className="flex min-w-0 items-center gap-1.5">{props.children}</span>
    </label>
  )
}

function ConnectorRow(props: {
  connector: ExportOptions['connectors'][number]
  picked: Set<string> | undefined
  onToggle: () => void
  onToggleEndpoint: (id: string) => void
}) {
  const c = props.connector
  const [open, setOpen] = useState(false)
  const partial = !!props.picked && props.picked.size < c.endpoints.length
  return (
    <div>
      <div className="flex items-center">
        <button
          type="button"
          aria-label={open ? `Esconder endpoints de ${c.name}` : `Mostrar endpoints de ${c.name}`}
          aria-expanded={open}
          disabled={!c.endpoints.length}
          onClick={() => setOpen(!open)}
          className="ml-1 flex size-6 shrink-0 items-center justify-center text-muted disabled:opacity-0"
        >
          <ChevronRight size={13} aria-hidden className={cx('transition-transform', open && 'rotate-90')} />
        </button>
        <div className="min-w-0 flex-1 [&>label]:pl-1">
          <Check label={c.name} checked={!!props.picked} onChange={props.onToggle}>
            <span className="truncate font-mono text-faint">{c.id}</span>
            {c.extends && <span className="text-muted">herda de {c.extends}</span>}
            <span className="text-muted">
              {partial ? `${props.picked!.size} de ${c.endpoints.length}` : c.endpoints.length} endpoint(s)
            </span>
            {c.hasDocs && <Badge>docs</Badge>}
          </Check>
        </div>
      </div>
      {open &&
        c.endpoints.map((e) => (
          <Check
            key={e.id}
            label={`${c.name} › ${e.name}`}
            indent={1.5}
            checked={!!props.picked?.has(e.id)}
            onChange={() => props.onToggleEndpoint(e.id)}
          >
            <MethodBadge method={e.method} className="w-14" />
            <span className="truncate font-mono">{e.path}</span>
            {e.scenarios > 0 && <span className="text-muted">{e.scenarios} cenário(s)</span>}
          </Check>
        ))}
    </div>
  )
}
