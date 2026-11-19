import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { FileDown, FolderOpen, Link, Sparkles, Workflow } from 'lucide-react'
import type {
  ArchiveImportPreview,
  ImportAdjustment,
  ImportConflictMode,
  ImportPlanInput,
  ImportSyncDecision,
  PostmanImportPreview,
  PostmanWriteResult
} from '@shared/ipc'
import { Badge, Button, cx, EmptyState, useToast } from '../../design-system'
import { ArchiveImport } from './ArchiveViews'
import { ImportInspector } from './ImportInspector'
import { ImportTree } from './ImportTree'
import { CONFLICT_LABEL, type Selection } from './model'
import { WORKSPACE_CHANGED } from '../useWorkspace'

/** O que a revisão do app decide (a spec ganhar por padrão é só do vvpost sync). */
type ReviewInput = Required<Omit<ImportPlanInput, 'specWins'>>


/**
 * Importa coleções e ambientes do Postman, pacotes do VVPost, specs OpenAPI/Swagger
 * (arquivo ou URL), exportações do Insomnia, coleções do Bruno, HAR e WSDL direto no projeto aberto (ou numa pasta escolhida). Antes de gravar,
 * a revisão mostra a árvore resultante e deixa ajustar a hierarquia e mesclar
 * requisições como cenários; cada ajuste é reaplicado no main process, que devolve a
 * nova prévia e os arquivos que mudariam. Reimportar uma spec (daqui ou pelo Catálogo,
 * com `reimport`) mostra o que mudou em cada endpoint e deixa escolher entre a spec e o projeto.
 */
export function ImportView({ reimport }: { reimport?: { connectorId: string; nonce: number } }) {
  const [preview, setPreview] = useState<PostmanImportPreview | null>(null)
  const [adjustments, setAdjustments] = useState<ImportAdjustment[]>([])
  const [conflicts, setConflicts] = useState<Record<string, ImportConflictMode>>({})
  const [environmentConflicts, setEnvironmentConflicts] = useState<Record<string, ImportConflictMode>>({})
  const [flowConflicts, setFlowConflicts] = useState<Record<string, ImportConflictMode>>({})
  const [syncDecisions, setSyncDecisions] = useState<Record<string, ImportSyncDecision>>({})
  const [selection, setSelection] = useState<Selection>(null)
  const [outcome, setOutcome] = useState<PostmanWriteResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [archive, setArchive] = useState<ArchiveImportPreview | null>(null)
  const notify = useToast()
  // Só a resposta do último pedido vale (ajustes em sequência rápida).
  const request = useRef(0)

  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    try {
      await task()
    } catch (err) {
      notify((err as Error).message, 'danger')
    } finally {
      setBusy(false)
    }
  }

  const replan = useCallback(
    async (input: ReviewInput, id = preview?.id) => {
      if (!id) return
      const n = ++request.current
      const next = await window.vvpost.planPostmanImport(id, input)
      if (n !== request.current) return
      setAdjustments(input.adjustments)
      setConflicts(input.conflicts)
      setEnvironmentConflicts(input.environmentConflicts)
      setFlowConflicts(input.flowConflicts)
      setSyncDecisions(input.syncDecisions)
      setPreview(next)
      setOutcome(null)
    },
    [preview?.id]
  )
  const input = (): ReviewInput => ({ adjustments, conflicts, environmentConflicts, flowConflicts, syncDecisions })

  /** Começa uma revisão nova (arquivos, URL ou reimportação). */
  const start = (load: () => Promise<PostmanImportPreview | null>) =>
    run(async () => {
      const next = await load()
      if (!next) return
      request.current++
      setPreview(next)
      setAdjustments([])
      setConflicts({})
      setEnvironmentConflicts({})
      setFlowConflicts({})
      setSyncDecisions({})
      setSelection(null)
      setOutcome(null)
    })
  const pick = () => start(() => window.vvpost.previewPostmanImport())
  const pickFolder = () => start(() => window.vvpost.previewPostmanImport({ folder: true }))
  const fromUrl = (url: string) => start(() => window.vvpost.previewUrlImport(url))
  /** Um .zip do VVPost (workspace ou projeto) tem a revisão própria: workspace novo ou projeto. */
  const pickArchive = () =>
    run(async () => {
      const next = await window.vvpost.previewArchiveImport()
      if (next) setArchive(next)
    })

  // "Reimportar a spec" no Catálogo.
  useEffect(() => {
    if (reimport) void start(() => window.vvpost.previewSpecReimport(reimport.connectorId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reimport?.nonce])

  const chooseTarget = () =>
    run(async () => {
      if (!preview) return
      const next = await window.vvpost.choosePostmanImportTarget(preview.id, input())
      if (!next) return
      request.current++
      setPreview(next)
      setOutcome(null)
    })

  const adjust = (a: ImportAdjustment) => run(() => replan({ ...input(), adjustments: [...adjustments, a] }))
  const applySuggestions = () =>
    run(() =>
      replan({
        ...input(),
        adjustments: [
          ...adjustments,
          ...(preview?.suggestions ?? []).map(
            (s): ImportAdjustment => ({
              op: 'mergeIntoScenario',
              connectorId: s.connectorId,
              endpointId: s.endpointId,
              into: { connector: { id: s.into.connectorId }, endpointId: s.into.endpointId }
            })
          )
        ]
      })
    )

  const save = () =>
    run(async () => {
      if (!preview) return
      const result = await window.vvpost.writePostmanImport(preview.id, input())
      if (!result.ok && result.reason === 'canceled') return
      setOutcome(result)
      if (result.ok) {
        notify(`${result.written.length} arquivo(s) gravado(s) no projeto`, 'success')
        window.dispatchEvent(new Event(WORKSPACE_CHANGED))
      }
    })

  if (archive) {
    return <ArchiveImport preview={archive} onPickAnother={() => void pickArchive()} onClose={() => setArchive(null)} />
  }

  if (!preview) {
    return (
      <EmptyState
        icon={<FileDown size={20} aria-hidden />}
        title="Importar no projeto"
        description="Um workspace ou projeto inteiro em .zip do VVPost abre como workspace novo ou entra como projeto. Pacotes do VVPost (.vvpost.bundle.json), coleções e ambientes do Postman, specs OpenAPI 3.x e Swagger 2.0, exportações do Insomnia, coleções do Bruno (a pasta, .bru ou JSON), HAR e WSDL entram direto no projeto aberto. Antes de gravar, você revisa a hierarquia, mescla requisições como cenários de teste e escolhe o que fica de fora. Reimportar uma spec mostra o que mudou e mantém cenários e documentação. Segredos nunca vão para arquivos versionados."
      >
        <div className="flex flex-col items-center gap-3">
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void pick()}>
              Escolher arquivos…
            </Button>
            <Button disabled={busy} onClick={() => void pickFolder()}>
              Pasta do Bruno…
            </Button>
            <Button disabled={busy} onClick={() => void pickArchive()}>
              Workspace ou projeto em .zip…
            </Button>
          </div>
          <UrlForm busy={busy} onSubmit={(url) => void fromUrl(url)} />
        </div>
      </EmptyState>
    )
  }

  const saved = outcome?.ok === true
  const imported = preview.connectors.filter((c) => c.origin === 'imported')
  const endpoints = preview.connectors.reduce((n, c) => n + c.endpoints.filter((e) => e.status === 'new').length, 0)
  const scenarios = preview.connectors.reduce(
    (n, c) => n + c.endpoints.reduce((m, e) => m + e.scenarios.filter((s) => s.isNew).length, 0),
    0
  )
  const synced = preview.connectors.flatMap((c) => c.endpoints).filter((e) => e.sync)
  const creates = preview.changes.filter((c) => c.action === 'create').length
  const updates = preview.changes.length - creates

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4">
          <h1 className="text-sm font-semibold">Importar no projeto</h1>
          {/* Em janela estreita (1024 px) o formulário de URL tomava a linha e o nome sumia: fica ao menos o começo, com o nome inteiro no title. */}
          <span className="min-w-24 truncate text-xs text-muted" title={preview.sources.map((s) => s.name).join(', ')}>
            {preview.sources.map((s) => s.name).join(', ')}
          </span>
          <span className="ml-auto" />
          <UrlForm busy={busy} compact onSubmit={(url) => void fromUrl(url)} />
          <Button size="sm" disabled={busy} onClick={() => void pick()}>
            Escolher arquivos…
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void pickFolder()}>
            Pasta do Bruno…
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void pickArchive()}>
            .zip…
          </Button>
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2 text-xs" aria-label="Destino">
          <FolderOpen size={14} aria-hidden className="text-muted" />
          {preview.target ? (
            <>
              <span className="text-muted">Destino:</span>
              <span className="truncate font-mono">{preview.target.dir}</span>
              {preview.target.isWorkspace && <Badge tone="accent">projeto aberto</Badge>}
            </>
          ) : (
            <span className="text-warning">Nenhum projeto aberto: escolha a pasta de destino.</span>
          )}
          <Button size="sm" variant={preview.target ? 'ghost' : 'primary'} className="ml-auto" disabled={busy} onClick={() => void chooseTarget()}>
            {preview.target ? 'Outra pasta…' : 'Escolher pasta de destino…'}
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
          <div className="flex flex-wrap gap-2 text-xs" aria-label="Resumo da importação">
            <Stat value={imported.length} label="conectores novos" />
            <Stat value={endpoints} label="endpoints" />
            <Stat value={scenarios} label="cenários" />
            {synced.length > 0 && (
              <>
                <Stat value={synced.filter((e) => e.status !== 'removed' && e.sync!.decision === 'spec').length} label="atualizados pela spec" />
                {synced.some((e) => e.status === 'conflict') && (
                  <Stat value={synced.filter((e) => e.status === 'conflict').length} label="em conflito" />
                )}
                {synced.some((e) => e.status === 'removed') && (
                  <Stat value={synced.filter((e) => e.status === 'removed').length} label="fora da spec" />
                )}
              </>
            )}
            <Stat value={preview.environments.filter((e) => !e.excluded).length} label="ambientes" />
            {preview.flows.length > 0 && (
              <Stat value={preview.flows.filter((f) => !f.excluded && f.conflict !== 'merge').length} label="fluxos" />
            )}
            {preview.docs > 0 && <Stat value={preview.docs} label="documentações" />}
            <Stat value={preview.secretValues} label="segredos fora do Git" />
          </div>

          {preview.errors.length > 0 && (
            <Notice tone="danger" title="Não dá para gravar">
              {preview.errors.map((e, i) => (
                <div key={i}>
                  <span className="font-mono">{e.file}</span>: {e.message}
                </div>
              ))}
            </Notice>
          )}

          {preview.suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-accent/35 bg-accent/8 px-3 py-2 text-xs">
              <Sparkles size={14} aria-hidden className="text-accent" />
              <span className="min-w-0 flex-1">
                {preview.suggestions.length} requisição(ões) parecem variações de outro endpoint (mesmo método e
                caminho):{' '}
                <span className="text-muted">
                  {preview.suggestions.map((s) => `${s.endpointName} → ${s.into.endpointName}`).join('; ')}
                </span>
              </span>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void applySuggestions()}>
                Mesclar em cenários
              </Button>
            </div>
          )}

          {(preview.warnings.length > 0 || preview.notes.length > 0) && (
            <Notice tone="warning" title={`Avisos (${preview.warnings.length + preview.notes.length})`}>
              {[...preview.warnings, ...preview.notes].map((w, i) => (
                <div key={i}>
                  <span className="text-fg">{w.source}</span>: {w.message}
                </div>
              ))}
            </Notice>
          )}

          <section className="flex flex-col gap-1.5">
            <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">Conectores</h2>
            <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-panel py-1">
              {preview.connectors.length ? (
                <ImportTree preview={preview} selection={selection} onSelect={setSelection} />
              ) : (
                <p className="px-3 py-2 text-xs text-muted">Nenhum conector neste import.</p>
              )}
            </div>
          </section>

          {preview.environments.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">Ambientes</h2>
              {preview.environments.map((env) => {
                const selected = selection?.kind === 'environment' && selection.key === env.key
                return (
                  <button
                    key={env.key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelection({ kind: 'environment', key: env.key })}
                    className={cx(
                      'flex flex-col gap-1.5 rounded-[var(--radius-card)] border px-3 py-2 text-left',
                      selected ? 'border-accent/50 bg-accent/8' : 'border-border bg-panel hover:border-faint',
                      env.excluded && 'opacity-50'
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium">{env.name}</span>
                      <span className="font-mono text-faint">{env.id}</span>
                      {env.excluded ? (
                        <Badge>fora do import</Badge>
                      ) : env.origin === 'existing' ? (
                        <Badge tone="info">no projeto</Badge>
                      ) : (
                        <Badge tone="success">novo</Badge>
                      )}
                      {env.conflict && !env.excluded && <Badge tone="warning">{CONFLICT_LABEL[env.conflict]}</Badge>}
                    </span>
                    <span className="flex flex-wrap gap-1.5">
                      {env.variables.map((v) => (
                        <Badge
                          key={v.name}
                          mono
                          tone={v.isSecret ? 'warning' : 'neutral'}
                          title={
                            v.exists
                              ? 'Já existe no ambiente do projeto: o valor de lá é mantido'
                              : v.isSecret
                                ? 'Segredo: commitado como __REQUIRED_SECRET__'
                                : undefined
                          }
                        >
                          {v.name}
                          {v.isSecret && ' · segredo'}
                          {v.exists && ' · mantido'}
                        </Badge>
                      ))}
                    </span>
                  </button>
                )
              })}
            </section>
          )}
          {preview.flows.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">Fluxos</h2>
              {preview.flows.map((flow) => {
                const selected = selection?.kind === 'flow' && selection.key === flow.key
                return (
                  <button
                    key={flow.key}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelection({ kind: 'flow', key: flow.key })}
                    className={cx(
                      'flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border px-3 py-2 text-left text-xs',
                      selected ? 'border-accent/50 bg-accent/8' : 'border-border bg-panel hover:border-faint',
                      flow.excluded && 'opacity-50'
                    )}
                  >
                    <Workflow size={14} aria-hidden className="text-muted" />
                    <span className="font-medium">{flow.name}</span>
                    <span className="font-mono text-faint">{flow.id}</span>
                    <span className="text-muted">{flow.nodes} nós</span>
                    {flow.excluded ? (
                      <Badge>fora do import</Badge>
                    ) : flow.origin === 'existing' ? (
                      <Badge tone="info">no projeto</Badge>
                    ) : (
                      <Badge tone="success">novo</Badge>
                    )}
                    {flow.conflict && !flow.excluded && <Badge tone="warning">{CONFLICT_LABEL[flow.conflict]}</Badge>}
                    {flow.missingConnectors && (
                      <Badge tone="danger" title={flow.missingConnectors.join(', ')}>
                        conector ausente
                      </Badge>
                    )}
                  </button>
                )
              })}
            </section>
          )}
        </div>

        <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-2.5">
          {outcome && <OutcomeView outcome={outcome} />}
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted" title={preview.changes.map((c) => `${c.action}: ${c.path}`).join('\n')}>
              {preview.target
                ? `${creates} arquivo(s) novo(s), ${updates} alterado(s)${preview.secretValues > 0 ? ' + segredos no cofre local' : ''}`
                : 'Escolha o destino para ver os arquivos'}
            </span>
            <Button variant="primary" className="ml-auto" disabled={busy || !preview.canWrite || saved} onClick={() => void save()}>
              {saved ? 'Importado' : 'Importar no projeto'}
            </Button>
          </div>
        </footer>
      </div>

      <ImportInspector
        preview={preview}
        selection={selection}
        adjustments={adjustments}
        busy={busy}
        onAdjust={(a) => void adjust(a)}
        onConflict={(key, mode) => void run(() => replan({ ...input(), conflicts: { ...conflicts, [key]: mode } }))}
        onEnvironmentConflict={(key, mode) =>
          void run(() => replan({ ...input(), environmentConflicts: { ...environmentConflicts, [key]: mode } }))
        }
        onFlowConflict={(key, mode) => void run(() => replan({ ...input(), flowConflicts: { ...flowConflicts, [key]: mode } }))}
        onSyncDecision={(key, decision) =>
          void run(() => replan({ ...input(), syncDecisions: { ...syncDecisions, [key]: decision } }))
        }
        onUndo={() => void run(() => replan({ ...input(), adjustments: adjustments.slice(0, -1) }))}
        onReset={() => void run(() => replan({ ...input(), adjustments: [] }))}
      />
    </div>
  )
}

/** URL de uma spec OpenAPI/Swagger (ou de outro arquivo de import) para baixar e revisar. */
function UrlForm(props: { busy: boolean; compact?: boolean; onSubmit: (url: string) => void }) {
  const [url, setUrl] = useState('')
  const valid = /^https?:\/\/\S+$/i.test(url.trim())
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid) props.onSubmit(url.trim())
  }
  return (
    <form onSubmit={submit} className={cx('flex items-center gap-2', props.compact ? 'w-80' : 'w-[26rem] max-w-full')} aria-label="Importar de uma URL">
      <Link size={14} aria-hidden className="shrink-0 text-muted" />
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://…/openapi.json"
        aria-label="URL da spec OpenAPI ou Swagger"
        className="h-7 min-w-0 flex-1 rounded-[var(--radius-control)] border border-border bg-surface px-2 text-xs text-fg outline-none focus:border-accent"
      />
      <Button size="sm" type="submit" disabled={props.busy || !valid}>
        {props.compact ? 'Importar URL' : 'Importar da URL'}
      </Button>
    </form>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="rounded-[var(--radius-control)] border border-border bg-panel px-2.5 py-1">
      <span className="font-semibold text-fg">{value}</span> <span className="text-muted">{label}</span>
    </span>
  )
}

function Notice(props: { tone: 'danger' | 'warning'; title: string; children: ReactNode }) {
  const tone = props.tone === 'danger' ? 'border-danger/40 text-danger' : 'border-warning/40 text-warning'
  return (
    <details open={props.tone === 'danger'} className={`rounded-[var(--radius-card)] border px-3 py-2 text-xs ${tone}`}>
      <summary className="cursor-pointer font-medium">{props.title}</summary>
      <div className="mt-2 flex flex-col gap-1 text-muted">{props.children}</div>
    </details>
  )
}

function OutcomeView({ outcome }: { outcome: PostmanWriteResult }) {
  if (outcome.ok) {
    return (
      <div className="text-xs text-success" role="status">
        {outcome.written.length} arquivo(s) gravado(s) em <span className="font-mono">{outcome.dir}</span>
      </div>
    )
  }
  if (outcome.reason === 'error') {
    return (
      <div className="text-xs text-danger" role="alert">
        {outcome.message}
      </div>
    )
  }
  return null
}
