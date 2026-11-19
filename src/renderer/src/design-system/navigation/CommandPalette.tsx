import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { cx } from '../cx'
import { Kbd } from '../primitives/Kbd'
import { matchesQuery } from './command-search'

export interface Command {
  id: string
  title: string
  /** Grupo mostrado à direita (Módulo, Serviço, Workspace). */
  group: string
  icon?: ReactNode
  hint?: string
  /** Outras palavras que acham o comando ("testar endpoint", o método e o caminho). */
  keywords?: readonly string[]
  run: () => void
}

/** Busca e execução de comandos (Ctrl+K): abrir módulos, ligar serviços, trocar workspace. */
export function CommandPalette(props: {
  commands: Command[]
  onClose: () => void
  /** Ctrl+Shift+F abre a mesma lista como busca no projeto. */
  placeholder?: string
  label?: string
  /** A lista ainda está carregando (busca no projeto). */
  loading?: boolean
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)

  const results = useMemo(() => {
    if (!query.trim()) return props.commands
    return props.commands.filter((c) => matchesQuery(query, c))
  }, [props.commands, query])

  useEffect(() => input.current?.focus(), [])
  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const run = (c: Command | undefined) => {
    if (!c) return
    props.onClose()
    c.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[index])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={props.onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.label ?? 'Paleta de comandos'}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-[min(36rem,90vw)] overflow-hidden rounded-[var(--radius-card)] bg-elevated shadow-[var(--shadow-overlay)]"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search size={16} className="text-muted" aria-hidden />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={props.placeholder ?? 'Buscar ou executar comando…'}
            aria-label={props.placeholder ? 'Procurar no projeto' : 'Buscar comando'}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={results[index] ? `cmd-${results[index].id}` : undefined}
            className="h-11 flex-1 !border-0 !bg-transparent text-sm !outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul
          id="command-palette-list"
          ref={list}
          role="listbox"
          aria-label="Comandos"
          className="max-h-80 overflow-auto p-1"
        >
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-muted">
              {props.loading ? 'Carregando o projeto…' : props.placeholder ? 'Nada encontrado no projeto.' : 'Nenhum comando encontrado.'}
            </li>
          )}
          {results.map((c, i) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === index}
              onMouseMove={() => setIndex(i)}
              onClick={() => run(c)}
              className={cx(
                'flex h-9 cursor-pointer items-center gap-3 rounded-[var(--radius-control)] px-3 text-[13px]',
                i === index ? 'bg-accent/15 text-fg' : 'text-muted'
              )}
            >
              <span className={cx('shrink-0', i === index ? 'text-accent' : 'text-muted')}>{c.icon}</span>
              <span className="min-w-0 flex-1 truncate text-fg">{c.title}</span>
              {c.hint && <Kbd>{c.hint}</Kbd>}
              <span className="text-[11px] text-faint">{c.group}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
