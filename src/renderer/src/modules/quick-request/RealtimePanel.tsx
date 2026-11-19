import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Copy, Info, Send, Trash2 } from 'lucide-react'
import type { RealtimeMessage, RealtimeProtocol } from '@shared/ipc'
import { Badge, Button, CodeEditor, cx, EmptyState, ErrorNotice, formatBytes, formatJson, IconButton, SegmentedControl, type Tone } from '../../design-system'
import type { LiveState } from './draft'

type Direction = 'all' | 'in' | 'out'
const icon = { size: 13, 'aria-hidden': true } as const

const STATUS: Record<LiveState['status'], { label: string; tone: Tone }> = {
  idle: { label: 'Desconectado', tone: 'neutral' },
  connecting: { label: 'Conectando…', tone: 'info' },
  open: { label: 'Conectado', tone: 'success' },
  closed: { label: 'Fechado', tone: 'neutral' },
  error: { label: 'Erro', tone: 'danger' }
}

const time = (at: string) => {
  const d = new Date(at)
  return `${d.toLocaleTimeString('pt-BR')}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

/**
 * Tela de mensagens de uma conexão realtime (fase 15): o estado, a lista de mensagens recebidas
 * e enviadas (com hora, evento e tamanho, filtro e JSON formatado ao abrir) e, no WebSocket e no
 * Socket.IO, a caixa de envio. Carregada sob demanda: só quem abre uma conexão paga por ela.
 */
export default function RealtimePanel(props: {
  protocol: RealtimeProtocol
  live: LiveState
  compose: { data: string; event: string }
  onCompose: (compose: { data: string; event: string }) => void
  onSend: () => void
  onClear: () => void
}) {
  const { live, protocol } = props
  const [filter, setFilter] = useState('')
  const [direction, setDirection] = useState<Direction>('all')
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const list = useRef<HTMLOListElement>(null)
  const stick = useRef(true)
  const status = STATUS[live.status]
  const canSend = protocol !== 'sse' && live.status === 'open' && (protocol !== 'socketio' || !!props.compose.event.trim())

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return live.messages.filter(
      (m) => (direction === 'all' || m.direction === direction) && (!q || m.data.toLowerCase().includes(q) || (m.event ?? '').toLowerCase().includes(q))
    )
  }, [live.messages, filter, direction])
  const received = live.messages.reduce((n, m) => n + (m.direction === 'in' ? 1 : 0), 0) + live.dropped
  const sent = live.messages.reduce((n, m) => n + (m.direction === 'out' ? 1 : 0), 0)

  // A lista acompanha as mensagens novas enquanto quem lê está no fim dela.
  useLayoutEffect(() => {
    if (stick.current && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [shown.length])

  const toggle = (seq: number) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col" role="region" aria-label="Mensagens da conexão">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-xs">
        <Badge tone={status.tone}>{status.label}</Badge>
        {live.url && live.status !== 'idle' && <span className="max-w-[40%] truncate font-mono text-muted" title={live.url}>{live.url}</span>}
        {live.detail && live.status !== 'error' && <span className="truncate text-muted">{live.detail}</span>}
        <span className="text-muted" aria-label="Contagem de mensagens">
          {received} recebidas{protocol !== 'sse' && ` · ${sent} enviadas`}
        </span>
        <span className="flex-1" />
        <SegmentedControl<Direction>
          label="Direção das mensagens"
          size="xs"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'all', label: 'Todas' },
            { value: 'in', label: 'Recebidas' },
            ...(protocol !== 'sse' ? [{ value: 'out' as const, label: 'Enviadas' }] : [])
          ]}
        />
        <input
          aria-label="Filtrar mensagens"
          placeholder="Filtrar"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-6 w-36 border px-2 text-xs"
        />
        <IconButton label="Limpar as mensagens" disabled={!live.messages.length} onClick={props.onClear}>
          <Trash2 {...icon} />
        </IconButton>
      </div>
      {live.status === 'error' && (
        <div className="shrink-0 px-3 pt-2">
          <ErrorNotice compact title="A conexão falhou" code={live.code ?? 'NETWORK_ERROR'} message={live.detail ?? 'erro na conexão'} hint="Confira a URL, o protocolo, os headers e a auth do conector." />
        </div>
      )}
      {live.messages.length === 0 && live.status !== 'error' ? (
        <EmptyState
          title={live.status === 'open' ? 'Conectado, sem mensagens ainda' : 'Nenhuma mensagem'}
          description={
            live.status === 'idle' || live.status === 'closed'
              ? 'Conecte com o botão ou Ctrl+Enter. As mensagens recebidas e enviadas aparecem aqui.'
              : protocol === 'sse'
                ? 'Os eventos do servidor aparecem aqui conforme chegam.'
                : 'Escreva uma mensagem embaixo e envie com Ctrl+Enter.'
          }
        />
      ) : (
        <ol
          ref={list}
          aria-label="Mensagens"
          className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs"
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          {live.dropped > 0 && <li className="px-3 py-1 text-faint">{live.dropped} mensagens mais antigas saíram da lista</li>}
          {shown.map((m) => (
            <MessageRow key={m.seq} message={m} open={open.has(m.seq)} onToggle={() => toggle(m.seq)} />
          ))}
        </ol>
      )}
      {protocol !== 'sse' && (
        <div className="flex h-28 shrink-0 flex-col border-t border-border-subtle">
          <div
            className="flex min-h-0 flex-1"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                if (canSend) props.onSend()
              }
            }}
          >
            {protocol === 'socketio' && (
              <label className="flex w-40 shrink-0 flex-col gap-1 border-r border-border-subtle p-2 text-xs text-muted">
                Evento
                <input
                  aria-label="Nome do evento"
                  placeholder="mensagem"
                  value={props.compose.event}
                  onChange={(e) => props.onCompose({ ...props.compose, event: e.target.value })}
                  className="h-7 border px-2 font-mono text-xs text-fg"
                />
              </label>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <CodeEditor
                ariaLabel="Mensagem a enviar"
                language="json"
                value={props.compose.data}
                onChange={(data) => props.onCompose({ ...props.compose, data })}
                placeholder={protocol === 'socketio' ? '{ "texto": "oi" }  (o argumento do evento; {{VAR}} vale)' : 'Texto ou JSON; {{VAR}} vale'}
              />
            </div>
            <div className="flex shrink-0 flex-col justify-end gap-1 p-2">
              <Button size="sm" variant="primary" icon={<Send {...icon} />} disabled={!canSend} onClick={props.onSend} title="Enviar (Ctrl+Enter)">
                Enviar mensagem
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MessageRow(props: { message: RealtimeMessage; open: boolean; onToggle: () => void }) {
  const m = props.message
  const pretty = useMemo(() => (props.open && !m.binary ? formatJson(m.data) : m.data), [props.open, m.data, m.binary])
  const Arrow = m.direction === 'in' ? ArrowDownLeft : m.direction === 'out' ? ArrowUpRight : Info
  return (
    <li className={cx('group border-b border-border-subtle/60 px-3 py-1', m.direction === 'info' && 'text-muted')} aria-label={`Mensagem ${m.seq}`}>
      <div className="flex items-baseline gap-2">
        <Arrow
          {...icon}
          className={cx('shrink-0 self-center', m.direction === 'in' ? 'text-success' : m.direction === 'out' ? 'text-accent' : 'text-faint')}
          aria-label={m.direction === 'in' ? 'recebida' : m.direction === 'out' ? 'enviada' : 'do protocolo'}
        />
        <span className="shrink-0 text-faint">{time(m.at)}</span>
        {m.event && <Badge tone="cyan" mono>{m.event}</Badge>}
        <button
          type="button"
          className={cx('min-w-0 flex-1 text-left text-fg', !props.open && 'truncate')}
          aria-expanded={props.open}
          title={props.open ? 'Recolher' : 'Abrir a mensagem inteira'}
          onClick={props.onToggle}
        >
          {m.binary ? `[binário, ${formatBytes(m.bytes)}] ${props.open ? '' : m.data.slice(0, 120)}` : props.open ? '' : m.data || '(vazia)'}
        </button>
        <span className="shrink-0 text-faint">{formatBytes(m.bytes)}</span>
        <span className="invisible group-hover:visible">
          <IconButton label="Copiar a mensagem" onClick={() => void navigator.clipboard.writeText(m.data)}>
            <Copy {...icon} />
          </IconButton>
        </span>
      </div>
      {props.open && (
        <pre className="mt-1 max-h-80 overflow-auto rounded bg-elevated p-2 whitespace-pre-wrap break-all">
          {pretty}
          {m.truncated && <span className="block text-warning">(cortada na tela; a mensagem tinha {formatBytes(m.bytes)})</span>}
        </pre>
      )}
    </li>
  )
}
