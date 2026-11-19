import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, FolderOpen, LogIn, LogOut, X } from 'lucide-react'
import type {
  PublishAction,
  PublishApplied,
  PublishPlan,
  PublishPlanItem,
  PublishPrepared,
  PublishTargetsState,
  PublishTargetSummary
} from '@shared/ipc'
import { Badge, Button, controlClass, IconButton, type Tone } from '../../design-system'
import { renderMermaid } from '../../design-system/content/Markdown'
import { DiffView } from '../git/DiffView'

const ACTION: Record<PublishAction, { label: string; tone: Tone }> = {
  create: { label: 'nova', tone: 'success' },
  update: { label: 'muda', tone: 'accent' },
  same: { label: 'igual', tone: 'neutral' },
  conflict: { label: 'editada no destino', tone: 'warning' },
  orphan: { label: 'saiu da estrutura', tone: 'danger' }
}

const OUTCOME: Record<PublishApplied['items'][number]['outcome'], { label: string; tone: Tone }> = {
  created: { label: 'criada', tone: 'success' },
  updated: { label: 'atualizada', tone: 'accent' },
  unchanged: { label: 'igual', tone: 'neutral' },
  skipped: { label: 'mantida', tone: 'neutral' },
  archived: { label: 'arquivada', tone: 'warning' },
  failed: { label: 'falhou', tone: 'danger' }
}

type Step =
  | { kind: 'loading' }
  | { kind: 'targets' }
  | { kind: 'working'; label: string }
  | { kind: 'plan'; prepared: PublishPrepared; plan: PublishPlan }
  | { kind: 'confirm'; prepared: PublishPrepared; plan: PublishPlan }
  | { kind: 'done'; result: PublishApplied }

/**
 * "Enviar para…" da Documentação: escolhe o destino do vvpost.publish.json, entra com a conta
 * da pessoa, mostra o plano (o que é novo, o que muda, o que foi editado lá) e só publica o que
 * ela marcou. Página que já existe só muda com confirmação. Um exportador (o site html, os de
 * plugins) não tem conta: grava numa pasta do workspace, com o mesmo plano.
 */
export default function PublishDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<PublishTargetsState | null>(null)
  const [targetId, setTargetId] = useState('')
  const [step, setStep] = useState<Step>({ kind: 'loading' })
  const [error, setError] = useState<string | null>(null)
  const [approved, setApproved] = useState<ReadonlySet<string>>(new Set())
  const close = useRef<HTMLButtonElement>(null)
  const target = state?.targets.find((t) => t.id === targetId)

  const load = async () => {
    const r = await window.vvpost.publishTargets()
    if (!r.ok) {
      setError(r.message)
      setStep({ kind: 'targets' })
      return
    }
    setState(r.value)
    setTargetId((id) => (r.value.targets.some((t) => t.id === id) ? id : (r.value.targets[0]?.id ?? '')))
    setStep({ kind: 'targets' })
  }

  useEffect(() => {
    close.current?.focus()
    void load()
  }, [])

  const run = async <T,>(label: string, call: () => Promise<{ ok: true; value: T } | { ok: false; message: string }>): Promise<T | null> => {
    setError(null)
    const previous = step
    setStep({ kind: 'working', label })
    const r = await call()
    if (r.ok) return r.value
    setError(r.message)
    setStep(previous.kind === 'working' ? { kind: 'targets' } : previous)
    return null
  }

  const signIn = async (t: PublishTargetSummary, credential?: string) => {
    if ((await run('Entrando…', () => window.vvpost.publishSignIn(t.id, credential))) !== null) await load()
  }
  const signOut = async (t: PublishTargetSummary) => {
    if ((await run('Saindo…', () => window.vvpost.publishSignOut(t.id))) !== null) await load()
  }

  const preparePlan = async (t: PublishTargetSummary) => {
    const prepared = await run('Montando as páginas…', () => window.vvpost.publishPrepare(t.id))
    if (!prepared) return
    setStep({ kind: 'working', label: `Desenhando ${prepared.diagrams.length} diagrama(s)…` })
    const images = t.diagrams === 'code' ? [] : await drawDiagrams(prepared.diagrams)
    const plan = await run('Comparando com o destino…', () => window.vvpost.publishPlan(prepared.id, images))
    if (!plan) return
    // Mudança comum vem marcada; página editada no destino e arquivamento, a pessoa marca.
    setApproved(new Set(plan.items.filter((i) => i.action === 'update').map((i) => i.key)))
    setStep({ kind: 'plan', prepared, plan })
  }

  const publish = async (prepared: PublishPrepared, plan: PublishPlan) => {
    const keys = (a: PublishAction) => plan.items.filter((i) => i.action === a && approved.has(i.key)).map((i) => i.key)
    const result = await run(target?.local ? 'Exportando…' : 'Publicando…', () =>
      window.vvpost.publishApply(prepared.id, { update: keys('update'), conflicts: keys('conflict'), archive: keys('orphan') })
    )
    if (result) setStep({ kind: 'done', result })
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-8" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Enviar documentação"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && step.kind !== 'working' && onClose()}
        className="flex max-h-full w-[min(56rem,95vw)] flex-col overflow-hidden rounded-[var(--radius-card)] bg-panel shadow-[var(--shadow-overlay)]"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
          <span className="font-semibold">Enviar a documentação para…</span>
          <span className="flex-1" />
          <IconButton ref={close} label="Fechar" onClick={onClose} disabled={step.kind === 'working'}>
            <X size={14} aria-hidden />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
          {error && (
            <div role="alert" className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}
          {step.kind === 'loading' && <p className="text-muted">Lendo os destinos…</p>}
          {step.kind === 'working' && <p className="text-muted">{step.label}</p>}
          {step.kind === 'targets' && state && (
            <Targets
              state={state}
              target={target}
              onSelect={setTargetId}
              onSignIn={signIn}
              onSignOut={signOut}
              onCreate={async (provider, destination) => {
                if ((await run('Criando o vvpost.publish.json…', () => window.vvpost.publishInit(provider, destination))) !== null) await load()
              }}
            />
          )}
          {(step.kind === 'plan' || step.kind === 'confirm') && (
            <PlanView
              prepared={step.prepared}
              plan={step.plan}
              approved={approved}
              confirming={step.kind === 'confirm'}
              onToggle={(key) =>
                setApproved((s) => {
                  const next = new Set(s)
                  if (!next.delete(key)) next.add(key)
                  return next
                })
              }
            />
          )}
          {step.kind === 'done' && <Done result={step.result} />}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span className="flex-1" />
          {step.kind === 'targets' && target && (
            <Button
              variant="primary"
              size="sm"
              disabled={!target.available || target.session?.status !== 'signedIn'}
              title={target.session?.status !== 'signedIn' ? 'Entre com a sua conta primeiro' : undefined}
              onClick={() => void preparePlan(target)}
            >
              Ver o que vai mudar
            </Button>
          )}
          {step.kind === 'plan' && (
            <>
              <Button size="sm" onClick={() => setStep({ kind: 'targets' })}>
                Voltar
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!step.plan.items.some((i) => i.action === 'create' || approved.has(i.key))}
                onClick={() =>
                  // Página que já existe só muda com confirmação.
                  step.plan.items.some((i) => i.action !== 'create' && approved.has(i.key))
                    ? setStep({ kind: 'confirm', prepared: step.prepared, plan: step.plan })
                    : void publish(step.prepared, step.plan)
                }
              >
                {target?.local ? 'Exportar' : 'Publicar'}
              </Button>
            </>
          )}
          {step.kind === 'confirm' && (
            <>
              <Button size="sm" onClick={() => setStep({ kind: 'plan', prepared: step.prepared, plan: step.plan })}>
                Revisar de novo
              </Button>
              <Button variant="primary" size="sm" onClick={() => void publish(step.prepared, step.plan)}>
                {target?.local ? 'Confirmar e exportar' : 'Confirmar e publicar'}
              </Button>
            </>
          )}
          {step.kind === 'done' && (
            <Button variant="primary" size="sm" onClick={onClose}>
              Fechar
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Desenha os diagramas no tema claro (o destino é uma página branca); o que falhar vai como código. */
async function drawDiagrams(list: { id: string; source: string }[]): Promise<{ id: string; svg: string }[]> {
  const out: { id: string; svg: string }[] = []
  for (const d of list) {
    const source = /^\s*%%\{init/.test(d.source) ? d.source : `%%{init: {"theme": "default"}}%%\n${d.source}`
    const r = await renderMermaid(source)
    if ('svg' in r) out.push({ id: d.id, svg: r.svg })
  }
  return out
}

function Targets(props: {
  state: PublishTargetsState
  target: PublishTargetSummary | undefined
  onSelect: (id: string) => void
  onSignIn: (t: PublishTargetSummary, credential?: string) => void
  onSignOut: (t: PublishTargetSummary) => void
  onCreate: (provider: string, destination: string) => void
}) {
  const { state, target } = props
  const [provider, setProvider] = useState(state.providers[0]?.id ?? '')
  const [credential, setCredential] = useState('')
  const local = state.providers.find((p) => p.id === provider)?.local === true
  const [destination, setDestination] = useState(state.providers[0]?.local ? 'dist/site' : '')

  if (state.issues.length) {
    return (
      <div className="space-y-2">
        <p>O vvpost.publish.json tem problemas; corrija e abra de novo:</p>
        <ul className="list-disc pl-5 font-mono text-xs text-danger">
          {state.issues.map((i) => (
            <li key={i.message}>{i.message}</li>
          ))}
        </ul>
      </div>
    )
  }
  if (!state.configExists) {
    if (!state.providers.length) {
      return (
        <p className="text-muted">
          Nenhum publicador instalado. O envio para o Confluence Cloud vem com o VVPost Enterprise; a estrutura das páginas fica no
          vvpost.publish.json do repositório.
        </p>
      )
    }
    return (
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (destination.trim()) props.onCreate(provider, destination.trim())
        }}
      >
        <p>
          Este projeto ainda não tem destinos. O VVPost cria o <code>vvpost.publish.json</code> com uma estrutura de partida (o documento do
          projeto, os guias de docs/ e a referência de cada conector), que você ajusta e versiona com o resto.
        </p>
        <label className="flex flex-col gap-1 text-xs">
          Publicador
          <select
            className={controlClass}
            value={provider}
            onChange={(e) => {
              const next = state.providers.find((p) => p.id === e.target.value)
              setProvider(e.target.value)
              setDestination(next?.local ? 'dist/site' : '')
            }}
          >
            {state.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {local ? 'Pasta de saída, relativa ao workspace (como dist/site)' : 'Destino (do catálogo da organização, como catalog:pagamentos)'}
          <input className={controlClass} value={destination} onChange={(e) => setDestination(e.target.value)} />
        </label>
        <Button type="submit" size="sm" variant="primary" disabled={!destination.trim()}>
          Criar vvpost.publish.json
        </Button>
      </form>
    )
  }
  if (!state.targets.length) return <p className="text-muted">O vvpost.publish.json não tem destinos.</p>
  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-1 text-xs">
        Destino
        <select className={controlClass} value={target?.id ?? ''} onChange={(e) => props.onSelect(e.target.value)}>
          {state.targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.providerTitle ?? t.provider}
            </option>
          ))}
        </select>
      </label>
      {target && !target.available && (
        <p className="text-muted">
          O publicador “{target.provider}” não está instalado: ele vem com o VVPost Enterprise ou com um plugin do Extensions Hub.
        </p>
      )}
      {target?.local && (
        <p className="rounded-md border border-border px-3 py-2 text-xs text-muted">
          Exporta para a pasta <code>{target.destination}</code> do workspace. A próxima exportação compara com esta (o histórico de mudanças
          fica no vvpost-site.json da pasta).
        </p>
      )}
      {target?.session && !target.local && (
        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
          {target.session.status === 'signedIn' ? (
            <>
              <span className="flex-1">
                Conectado como <strong>{target.session.account ?? 'sua conta'}</strong>
                {target.session.destination && <> · publica em {target.session.destination}</>}
              </span>
              <Button size="sm" variant="ghost" icon={<LogOut size={14} aria-hidden />} onClick={() => props.onSignOut(target)}>
                Sair
              </Button>
            </>
          ) : (
            <>
              <span className="flex-1 text-muted">
                {target.session.message ?? 'Entre com a sua conta da empresa; o envio usa as suas permissões.'}
                {target.session.credential?.help && (
                  <>
                    {' '}
                    <a href={target.session.credential.help} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      Como gerar
                    </a>
                  </>
                )}
              </span>
              {target.session.status === 'signedOut' && target.session.credential && (
                // A credencial vai direto ao cofre local pelo main process; o campo é esvaziado ao entrar.
                <input
                  type="password"
                  autoComplete="off"
                  aria-label={target.session.credential.label}
                  placeholder={target.session.credential.label}
                  className={`${controlClass} w-48`}
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                />
              )}
              {target.session.status === 'signedOut' && (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<LogIn size={14} aria-hidden />}
                  disabled={!!target.session.credential && !credential.trim()}
                  onClick={() => {
                    const value = credential
                    setCredential('')
                    props.onSignIn(target, target.session?.credential ? value : undefined)
                  }}
                >
                  Entrar
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function PlanView(props: {
  prepared: PublishPrepared
  plan: PublishPlan
  approved: ReadonlySet<string>
  confirming: boolean
  onToggle: (key: string) => void
}) {
  const { plan, prepared, approved } = props
  const [open, setOpen] = useState<string | null>(null)
  const changed = useMemo(() => plan.items.filter((i) => i.action !== 'create' && i.action !== 'same' && approved.has(i.key)), [plan, approved])
  const tally = (a: PublishAction) => plan.items.filter((i) => i.action === a).length

  if (props.confirming) {
    return (
      <div className="space-y-2">
        <p>
          Estas páginas já existem em <strong>{plan.destination.label}</strong> e vão mudar. Confirma?
        </p>
        <ul className="list-disc pl-5">
          {changed.map((i) => (
            <li key={i.key}>
              {[...i.path, i.title].join(' / ')} <Badge tone={ACTION[i.action].tone}>{i.action === 'orphan' ? 'arquivar' : ACTION[i.action].label}</Badge>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        {prepared.pages} item(ns) em{' '}
        {plan.destination.url ? (
          <a href={plan.destination.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {plan.destination.label}
          </a>
        ) : (
          plan.destination.label
        )}
        : {tally('create')} nova(s), {tally('update')} com mudança, {tally('conflict')} editada(s) no destino, {tally('same')} igual(is).
      </p>
      {[...plan.warnings, ...prepared.diagnostics.map((d) => `${d.file}: ${d.message}`)].map((w) => (
        <p key={w} className="rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-warning">
          {w}
        </p>
      ))}
      <ul className="divide-y divide-border rounded-md border border-border">
        {plan.items.map((item) => (
          <PlanRow
            key={item.key}
            item={item}
            open={open === item.key}
            checked={approved.has(item.key)}
            onOpen={() => setOpen((k) => (k === item.key ? null : item.key))}
            onToggle={() => props.onToggle(item.key)}
          />
        ))}
      </ul>
    </div>
  )
}

function PlanRow(props: { item: PublishPlanItem; open: boolean; checked: boolean; onOpen: () => void; onToggle: () => void }) {
  const { item } = props
  const choice = item.action === 'update' || item.action === 'conflict' || item.action === 'orphan'
  const diff = item.before !== undefined || item.after !== undefined
  const label = item.action === 'orphan' ? 'Arquivar' : item.action === 'conflict' ? 'Sobrescrever' : 'Atualizar'
  return (
    <li className="px-3 py-1.5">
      <div className="flex items-center gap-2">
        {diff ? (
          <IconButton label={props.open ? 'Esconder diferenças' : 'Ver diferenças'} onClick={props.onOpen}>
            {props.open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          </IconButton>
        ) : (
          <span className="w-6" />
        )}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted">{item.path.length ? `${item.path.join(' / ')} / ` : ''}</span>
          {item.title}
          {item.kind === 'folder' && <span className="text-muted"> (pasta)</span>}
        </span>
        {item.action === 'conflict' && item.remote?.editedBy && (
          <span className="text-xs text-muted">
            por {item.remote.editedBy}
            {item.remote.editedAt && ` em ${new Date(item.remote.editedAt).toLocaleString('pt-BR')}`}
          </span>
        )}
        <Badge tone={ACTION[item.action].tone}>{ACTION[item.action].label}</Badge>
        {item.remote?.url && (
          <a href={item.remote.url} target="_blank" rel="noreferrer" title="Abrir no destino" className="text-muted hover:text-fg">
            <ExternalLink size={14} aria-hidden />
          </a>
        )}
        {choice && (
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={props.checked} onChange={props.onToggle} />
            {label}
          </label>
        )}
      </div>
      {props.open && diff && (
        <div className="mt-2 flex max-h-80 flex-col overflow-hidden rounded border border-border">
          <DiffView diff={{ path: item.title, before: item.before ?? null, after: item.after ?? null }} labels={['No destino', 'Vai ficar']} />
        </div>
      )}
    </li>
  )
}

function Done({ result }: { result: PublishApplied }) {
  return (
    <div className="space-y-3">
      {result.warning && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-warning">{result.warning}</p>
      )}
      {result.recorded && (
        <p className="text-xs text-muted">Os ids das páginas foram gravados no vvpost.publish.json: faça o commit para a próxima publicação achar as mesmas páginas.</p>
      )}
      {result.destination.path && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="flex-1">
            Exportado em <code>{result.destination.path}</code>.
          </span>
          <Button
            size="sm"
            icon={<FolderOpen size={14} aria-hidden />}
            onClick={() => void window.vvpost.revealInFolder({ workspacePath: result.destination.path! })}
          >
            Abrir a pasta
          </Button>
        </div>
      )}
      <ul className="divide-y divide-border rounded-md border border-border">
        {result.items.map((i) => (
          <li key={i.key} className="flex items-center gap-2 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate">
              {i.title}
              {i.error && <span className="block text-xs text-danger">{i.error}</span>}
            </span>
            <Badge tone={OUTCOME[i.outcome].tone}>{OUTCOME[i.outcome].label}</Badge>
            {i.url && (
              <a href={i.url} target="_blank" rel="noreferrer" title="Abrir" className="text-muted hover:text-fg">
                <ExternalLink size={14} aria-hidden />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
