import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Play, RotateCcw, Square } from 'lucide-react'
import { Button } from '../primitives/Button'
import { Kbd } from '../primitives/Kbd'
import { formatMs } from '../format'

export type ExecutionState = 'idle' | 'running' | 'done' | 'failed' | 'cancelled'

/**
 * Ciclo de execução comum a requests, fluxos e cenários: executar, cancelar, repetir e
 * acompanhar. O tempo mostrado durante a execução é o relógio real desde o disparo; o resultado
 * (status, duração do motor) vem de quem executa, em `summary`. Ctrl/Cmd+Enter executa quando a
 * barra está visível.
 */
export function ExecutionToolbar(props: {
  state: ExecutionState
  onRun: () => void
  onCancel?: () => void
  /** Rótulo do botão de executar (Enviar, Rodar fluxo, Rodar cenários). */
  runLabel: string
  runIcon?: ReactNode
  canRun?: boolean
  /** Campos à esquerda do botão (método e URL, escolha do fluxo...). */
  children?: ReactNode
  /** Resultado da última execução (status, duração, tamanho). */
  summary?: ReactNode
  onRepeat?: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const running = props.state === 'running'
  const canRun = props.canRun ?? true
  const run = useRef(props.onRun)
  run.current = props.onRun

  const cancel = useRef(props.onCancel)
  cancel.current = props.onCancel

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Um menu ou campo que já tratou a tecla (Ctrl+Enter no item focado) não dispara de novo.
      if (e.defaultPrevented || !root.current?.offsetParent) return
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !running && canRun) {
        e.preventDefault()
        run.current()
      }
      // Esc cancela só com uma execução cancelável em andamento, e fora de diálogos e menus.
      else if (e.key === 'Escape' && running && cancel.current && !document.querySelector('[role="dialog"], [data-context-menu]')) {
        e.preventDefault()
        cancel.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, canRun])

  return (
    <div ref={root} className="flex min-w-0 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">{props.children}</div>
      {running ? (
        <Button
          variant="secondary"
          icon={<Square size={13} aria-hidden />}
          onClick={props.onCancel}
          disabled={!props.onCancel}
          title={props.onCancel ? 'Cancelar (Esc)' : undefined}
        >
          Cancelar
        </Button>
      ) : (
        <Button
          type="submit"
          variant="primary"
          icon={props.runIcon ?? <Play size={14} aria-hidden />}
          disabled={!canRun}
          onClick={(e) => {
            // Dentro de um <form>, o submit do form já executa.
            if (!e.currentTarget.form) props.onRun()
          }}
          title="Executar (Ctrl+Enter)"
        >
          {props.runLabel}
          <span className="max-xl:hidden">
            <Kbd>Ctrl+↵</Kbd>
          </span>
        </Button>
      )}
      {props.onRepeat && !running && props.state !== 'idle' && (
        <Button
          variant="ghost"
          size="md"
          icon={<RotateCcw size={14} aria-hidden />}
          onClick={props.onRepeat}
          aria-label="Repetir"
          title="Repetir a última execução"
        />
      )}
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted" aria-live="polite">
        {running ? <Elapsed /> : props.summary}
      </div>
    </div>
  )
}

/** Relógio da execução em andamento: tempo real desde o disparo, nunca um progresso simulado. */
function Elapsed() {
  const [start] = useState(() => performance.now())
  const [now, setNow] = useState(start)
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 100)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="flex items-center gap-1.5 font-mono">
      <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      {formatMs(now - start)}
    </span>
  )
}
