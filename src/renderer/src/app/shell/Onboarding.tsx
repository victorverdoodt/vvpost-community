import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Circle, ListChecks, X } from 'lucide-react'
import type { HistorySource, SecretInventory, WorkspaceInfo } from '@shared/ipc'
import { Button, cx } from '../../design-system'
import { WORKSPACE_CHANGED } from '../../panels/useWorkspace'
import { showNewProject } from './NewProject'

const HIDDEN_KEY = 'vvpost.onboarding.hidden'
const SHOW = 'vvpost:onboarding-show'

/** "Mostrar os primeiros passos" da paleta: volta a mostrar e abre o painel, mesmo depois de ocultar. */
export function showOnboarding(): void {
  window.dispatchEvent(new Event(SHOW))
}

interface Progress {
  /** Ambientes com segredo sem valor; só nomes e contagens, nunca valores. */
  pending: { environment: string; count: number }[]
  hasSecrets: boolean
  /** Fontes do histórico com ao menos uma execução bem-sucedida. */
  passed: ReadonlySet<HistorySource>
}

interface Step {
  id: string
  title: string
  description: string
  done: boolean
  action?: { label: string; run: () => void }
  secondary?: { label: string; run: () => void }[]
}

function remembered(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

function rememberHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, '1')
    else localStorage.removeItem(HIDDEN_KEY)
  } catch {
    // sem armazenamento local: volta a aparecer na próxima abertura
  }
}

/** Lê o que já foi feito: o progresso vem das tarefas concluídas, não das telas visitadas. */
async function readProgress(): Promise<Progress> {
  const [inventory, ...runs] = await Promise.all([
    window.vvpost.getSecretInventory(),
    ...(['request', 'scenarios', 'flow'] as const).map((source) =>
      window.vvpost.listHistory({ source, limit: 20 }).then((list) => ({ source, list }))
    )
  ])
  const inv: SecretInventory | null = inventory.ok ? inventory.value : null
  return {
    pending: (inv?.environments ?? [])
      .map((e) => ({ environment: e.name, count: e.secrets.filter((s) => s.state === 'missing').length }))
      .filter((e) => e.count > 0),
    hasSecrets: (inv?.environments ?? []).some((e) => e.secrets.length > 0),
    passed: new Set(runs.filter((r) => r.list.some((h) => h.outcome === 'passed')).map((r) => r.source))
  }
}

/**
 * Primeiros passos: ensina sem interromper. Fica na status bar com o
 * progresso e só abre quando a pessoa pede; cada etapa leva ao módulo certo e pode ser pulada.
 * Os segredos pendentes aparecem por ambiente e contagem, sem valores. Nada é ligado ou gravado
 * por aqui: MCP, plugins e o mock de segredos continuam desligados até a pessoa ligar.
 */
export function Onboarding(props: {
  workspace: WorkspaceInfo | null
  activeId: string
  onOpen: (id: string) => void
  onOpenWorkspace: () => void
}) {
  const [hidden, setHidden] = useState(remembered)
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => void readProgress().then(setProgress), [])
  useEffect(() => {
    const show = () => {
      rememberHidden(false)
      setHidden(false)
      refresh()
      setOpen(true)
    }
    window.addEventListener(SHOW, show)
    return () => window.removeEventListener(SHOW, show)
  }, [refresh])
  // Relido ao trocar de módulo ou de pasta e quando a janela volta ao foco; sem polling.
  useEffect(() => {
    if (hidden) return
    // Histórico e inventário abrem o SQLite e leem o workspace: fora do cold start.
    const handle = requestIdleCallback(refresh, { timeout: 3000 })
    window.addEventListener('focus', refresh)
    window.addEventListener(WORKSPACE_CHANGED, refresh)
    return () => {
      cancelIdleCallback(handle)
      window.removeEventListener('focus', refresh)
      window.removeEventListener(WORKSPACE_CHANGED, refresh)
    }
  }, [hidden, refresh, props.activeId, props.workspace?.dir])

  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLElement>('button')?.focus()
    const onDown = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  if (hidden) return null

  const go = (id: string) => () => {
    setOpen(false)
    props.onOpen(id)
  }
  const ws = props.workspace
  const pendingText = progress?.pending.map((p) => `${p.count} em ${p.environment}`).join(', ')
  const steps: Step[] = [
    {
      id: 'project',
      title: 'Criar, abrir ou importar um projeto',
      description: ws
        ? `Projeto aberto: ${ws.name}.`
        : 'Um projeto novo a partir de um modelo, uma pasta VVPost, uma coleção do Postman ou um pacote do VVPost. O importador mostra o que vai mudar antes de gravar.',
      done: !!ws,
      ...(!ws && {
        action: { label: 'Novo projeto…', run: () => (setOpen(false), showNewProject()) },
        secondary: [
          { label: 'Abrir pasta…', run: () => (setOpen(false), props.onOpenWorkspace()) },
          { label: 'Importar', run: go('import-export') }
        ]
      })
    },
    {
      id: 'secrets',
      title: 'Configurar os segredos pendentes',
      description: !ws
        ? 'Depois de abrir o projeto.'
        : pendingText
          ? `Faltam valores (${pendingText}). Os valores ficam só nesta máquina e nunca aparecem aqui.`
          : progress?.hasSecrets
            ? 'Todos os ambientes têm os segredos configurados.'
            : 'O projeto não usa segredos.',
      done: !!ws && !!progress && progress.pending.length === 0,
      ...(ws && progress?.pending.length ? { action: { label: 'Abrir Secrets', run: go('secrets') } } : {})
    },
    {
      id: 'request',
      title: 'Fazer a primeira requisição',
      description:
        'Escolha conector, ambiente e endpoint no Quick Request e envie; a resposta mostra de onde veio a auth.',
      done: !!progress?.passed.has('request'),
      action: { label: 'Abrir Quick Request', run: go('quick-request') }
    },
    {
      id: 'scenarios',
      title: 'Rodar os cenários de teste',
      description: 'A matriz roda os cenários em vários ambientes e mostra a asserção que falhou.',
      done: !!progress?.passed.has('scenarios'),
      action: { label: 'Abrir Cenários', run: go('scenarios') }
    },
    {
      id: 'flow',
      title: 'Rodar um fluxo',
      description: 'O Flow Studio encadeia requisições e usa a saída de um nó no seguinte.',
      done: !!progress?.passed.has('flow'),
      action: { label: 'Abrir Flow Studio', run: go('flows') }
    },
    {
      id: 'git',
      title: 'Versionar com o Git',
      description: 'Os segredos ficam fora dos commits; o assistente avisa antes de qualquer valor sair da máquina.',
      done: !!ws?.branch,
      action: { label: 'Abrir Git', run: go('git') }
    }
  ]
  const done = steps.filter((s) => s.done).length
  if (done === steps.length && !open) return null

  const hide = () => {
    rememberHidden(true)
    setHidden(true)
    setOpen(false)
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => {
          if (!open) refresh()
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        aria-controls="onboarding-panel"
        title="Primeiros passos: o que falta para usar o VVPost no seu projeto"
        className="flex items-center gap-1.5 rounded px-2 py-0.5 text-accent hover:bg-border/60"
      >
        <ListChecks size={12} aria-hidden />
        Primeiros passos {done}/{steps.length}
      </button>
      {open && (
        <div
          ref={panel}
          id="onboarding-panel"
          role="dialog"
          aria-label="Primeiros passos"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            setOpen(false)
            trigger.current?.focus()
          }}
          className="fixed bottom-7 left-14 z-30 flex max-h-[calc(100vh-5rem)] w-96 max-w-[calc(100vw-4rem)] flex-col overflow-y-auto rounded-[var(--radius-card)] border border-border bg-elevated text-xs text-fg shadow-xl"
        >
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <span className="text-sm font-semibold">Primeiros passos</span>
            <span className="text-muted">
              {done} de {steps.length}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Fechar primeiros passos"
              className="rounded p-1 text-muted hover:bg-border/60 hover:text-fg"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
          <ol className="flex flex-col">
            {steps.map((s) => (
              <li key={s.id} className="flex gap-2.5 border-b border-border-subtle px-3 py-2.5 last:border-b-0">
                {s.done ? (
                  <Check size={14} aria-hidden className="mt-0.5 shrink-0 text-success" />
                ) : (
                  <Circle size={14} aria-hidden className="mt-0.5 shrink-0 text-faint" />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={cx('font-medium', s.done && 'text-muted')}>
                    {s.title}
                    <span className="sr-only">{s.done ? ' (concluída)' : ' (pendente)'}</span>
                  </span>
                  <span className="text-muted">{s.description}</span>
                  {!s.done && (s.action || s.secondary) && (
                    <span className="flex gap-2 pt-0.5">
                      {s.action && (
                        <Button size="sm" variant="secondary" onClick={s.action.run}>
                          {s.action.label}
                        </Button>
                      )}
                      {s.secondary?.map((b) => (
                        <Button key={b.label} size="sm" variant="ghost" onClick={b.run}>
                          {b.label}
                        </Button>
                      ))}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="flex items-center gap-2 border-t border-border-subtle px-3 py-2 text-muted">
            <span className="flex-1">MCP, plugins e o mock de segredos ficam desligados até você ligar.</span>
            <button
              type="button"
              onClick={hide}
              className="rounded px-1 text-muted underline-offset-2 hover:text-fg hover:underline"
            >
              Não mostrar mais
            </button>
          </div>
        </div>
      )}
    </>
  )
}
