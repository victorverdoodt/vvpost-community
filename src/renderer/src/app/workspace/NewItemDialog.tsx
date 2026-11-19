import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, FlaskConical, FolderPlus, KeyRound, Network, Plus, Route, Shapes, Workflow, Zap } from 'lucide-react'
import { markdownFileName } from '@vvpost/core/docs/markdown-name'
import { Button, controlClass, cx, ErrorNotice, Kbd, formatShortcut, Shortcut } from '../../design-system'
import { navigate } from '../../lib/navigate'
import { useWorkspace } from '../../panels/useWorkspace'
import { showNewProject } from '../shell/NewProject'
import { filesChanged, openDoc } from './docs'
import type { NewItemKind } from './NewItem'

type Kind = NewItemKind

const icon = { size: 18, strokeWidth: 1.75, 'aria-hidden': true } as const

const OPTIONS: { kind: Kind; label: string; description: string; icon: ReactNode; hint?: string }[] = [
  { kind: 'request', label: 'Requisição', description: 'Quick Request: HTTP, GraphQL, WebSocket ou plugin, com a herança do conector', icon: <Zap {...icon} />, hint: Shortcut.newRequest },
  { kind: 'flow', label: 'Fluxo', description: 'Requisições, condições, Python e webhooks em sequência no canvas', icon: <Workflow {...icon} /> },
  { kind: 'connector', label: 'Fluxo-base (conector)', description: 'URL base, auth, headers e mTLS que as requisições herdam', icon: <Network {...icon} /> },
  { kind: 'endpoint', label: 'Requisição de uma base (endpoint)', description: 'Uma operação que herda URL e auth da base, no editor dela', icon: <Route {...icon} /> },
  { kind: 'scenario', label: 'Cenário de teste', description: 'Overrides e asserções de um endpoint, por ambiente', icon: <FlaskConical {...icon} /> },
  { kind: 'environment', label: 'Ambiente', description: 'Variáveis e segredos de dev, staging, produção…', icon: <KeyRound {...icon} /> },
  { kind: 'markdown', label: 'Documento', description: 'Markdown com as diretivas {{> ...}}: documentação viva, com prévia ou raw', icon: <BookOpen {...icon} /> },
  { kind: 'diagram', label: 'Diagrama', description: 'Mermaid (.mmd) com prévia ao vivo, ícones e blocos', icon: <Shapes {...icon} /> },
  { kind: 'project', label: 'Projeto a partir de um modelo', description: 'Uma pasta nova com conectores, ambientes e fluxos de exemplo', icon: <FolderPlus {...icon} /> }
]

/** O modal Novo: a lista do que criar e, quando precisa, o nome ou o conector. */
export default function NewItemDialog(props: { onClose: () => void; onNewRequest: () => void; initial?: Kind }) {
  const ws = useWorkspace()
  // Aberto pelo menu de uma seção do explorador: já no passo do tipo (nome, conector...).
  const [step, setStep] = useState<Kind | null>(props.initial ?? null)
  const [cursor, setCursor] = useState(0)
  const [name, setName] = useState('')
  const [connectorId, setConnectorId] = useState('')
  const [endpointId, setEndpointId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const restore = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    if (!step) list.current?.querySelector<HTMLElement>('[data-option]')?.focus()
    const back = restore.current
    return () => back?.focus()
  }, [])

  const connectors = (ws.workspace?.connectors ?? []).filter((c) => !c.shared && !c.error)
  const connector = connectors.find((c) => c.id === connectorId) ?? connectors[0]
  const endpoint = connector?.endpoints.find((e) => e.id === endpointId) ?? connector?.endpoints[0]
  const noWorkspace = !ws.workspace

  const done = () => props.onClose()
  const choose = (kind: Kind) => {
    setError(null)
    switch (kind) {
      case 'request':
        done()
        return props.onNewRequest()
      case 'connector':
        done()
        return openDoc({ kind: 'connector', connectorId: null })
      case 'diagram':
        done()
        return openDoc({ kind: 'diagram', file: null })
      case 'environment':
        done()
        return navigate({ module: 'secrets' })
      case 'project':
        done()
        return showNewProject()
      default:
        setName('')
        setStep(kind)
    }
  }

  const submit = async () => {
    setError(null)
    if (step === 'flow') {
      if (!name.trim()) return
      done()
      // Um rascunho novo no Flow Studio: vai para flows/ quando for salvo.
      return navigate({ module: 'flows', flowId: '', flow: { id: 'flow.novo', name: name.trim(), nodes: [], edges: [] } })
    }
    if (step === 'endpoint') {
      if (!connector) return
      done()
      return openDoc({ kind: 'connector', connectorId: connector.id })
    }
    if (step === 'scenario') {
      if (!connector || !endpoint) return
      done()
      return openDoc({ kind: 'scenario', connectorId: connector.id, endpointId: endpoint.id })
    }
    if (step === 'markdown') {
      const title = name.trim()
      if (!title) return
      let file: string
      try {
        file = markdownFileName(title)
      } catch (err) {
        return setError((err as Error).message)
      }
      setBusy(true)
      const r = await window.vvpost.saveMarkdownFile({ file, text: `# ${title}\n\n`, create: true })
      setBusy(false)
      if (!r.ok) return setError(r.message)
      filesChanged()
      done()
      openDoc({ kind: 'markdown', file: r.value.file })
    }
  }

  const onListKey = (e: React.KeyboardEvent) => {
    const max = OPTIONS.length - 1
    let next: number | null = null
    if (e.key === 'ArrowDown') next = cursor >= max ? 0 : cursor + 1
    else if (e.key === 'ArrowUp') next = cursor <= 0 ? max : cursor - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = max
    if (next === null) return
    e.preventDefault()
    setCursor(next)
    list.current?.querySelectorAll<HTMLElement>('[data-option]')[next]?.focus()
  }

  const current = OPTIONS.find((o) => o.kind === step)
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[10vh]" onMouseDown={props.onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Novo"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          if (step) setStep(null)
          else props.onClose()
        }}
        className="flex max-h-[80vh] w-[min(34rem,92vw)] flex-col gap-3 overflow-auto rounded-[var(--radius-card)] bg-elevated p-4 text-xs shadow-[var(--shadow-overlay)]"
      >
        <div className="flex items-center gap-2">
          <Plus size={16} className="text-accent" aria-hidden />
          <h2 className="flex-1 text-[13px] font-semibold text-fg">{current ? `Novo: ${current.label}` : 'Criar novo'}</h2>
          <Kbd>{formatShortcut('Mod+Shift+N')}</Kbd>
        </div>
        {!step ? (
          <div ref={list} role="listbox" aria-label="O que criar" onKeyDown={onListKey} className="grid gap-1 sm:grid-cols-2">
            {OPTIONS.map((o, i) => {
              const disabled = noWorkspace && o.kind !== 'request' && o.kind !== 'project'
              return (
                <button
                  key={o.kind}
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  data-option={o.kind}
                  tabIndex={i === cursor ? 0 : -1}
                  disabled={disabled}
                  title={disabled ? 'Abra um workspace antes' : undefined}
                  onFocus={() => setCursor(i)}
                  onClick={() => choose(o.kind)}
                  className={cx(
                    'flex items-start gap-2.5 rounded-[var(--radius-control)] border border-transparent p-2.5 text-left',
                    'hover:border-border hover:bg-surface focus-visible:border-accent focus-visible:outline-none disabled:opacity-40'
                  )}
                >
                  <span className="mt-0.5 shrink-0 text-accent">{o.icon}</span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                      {o.label}
                      {o.hint && <span className="text-[11px] font-normal text-faint">{formatShortcut(o.hint)}</span>}
                    </span>
                    <span className="text-muted">{o.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <p className="text-muted">{current?.description}</p>
            {(step === 'flow' || step === 'markdown') && (
              <label className="flex flex-col gap-1">
                <span className="text-muted">{step === 'flow' ? 'Nome do fluxo' : 'Título do documento'}</span>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={controlClass} />
                {step === 'markdown' && name.trim() && (
                  <span className="font-mono text-faint">{safeName(name)}</span>
                )}
              </label>
            )}
            {(step === 'endpoint' || step === 'scenario') && (
              <>
                {connectors.length === 0 && <p className="text-warning">O workspace ainda não tem conector editável. Crie um conector antes.</p>}
                <label className="flex flex-col gap-1">
                  <span className="text-muted">Conector</span>
                  <select
                    autoFocus
                    value={connector?.id ?? ''}
                    onChange={(e) => {
                      setConnectorId(e.target.value)
                      setEndpointId('')
                    }}
                    className={controlClass}
                  >
                    {connectors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                {step === 'scenario' && (
                  <label className="flex flex-col gap-1">
                    <span className="text-muted">Endpoint</span>
                    <select value={endpoint?.id ?? ''} onChange={(e) => setEndpointId(e.target.value)} className={controlClass}>
                      {connector?.endpoints.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.method} {e.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {step === 'endpoint' && <p className="text-muted">O endpoint é adicionado no editor do conector, na seção Endpoints.</p>}
              </>
            )}
            {error && <ErrorNotice compact title="Não foi possível criar" code="CONFIG_ERROR" message={error} />}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setStep(null)}>
                Voltar
              </Button>
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={
                  busy ||
                  ((step === 'flow' || step === 'markdown') && !name.trim()) ||
                  ((step === 'endpoint' || step === 'scenario') && !connector) ||
                  (step === 'scenario' && !endpoint)
                }
              >
                {step === 'endpoint' ? 'Abrir o conector' : 'Criar'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function safeName(title: string): string {
  try {
    return markdownFileName(title)
  } catch {
    return ''
  }
}
