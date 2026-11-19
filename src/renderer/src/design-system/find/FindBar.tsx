import type { Ref } from 'react'
import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { cx } from '../cx'
import { matchesShortcut, Shortcut, type KeyLike } from '../navigation/shortcuts'
import { IconButton, controlClass } from '../primitives/Button'

/** O estado de uma busca: o texto, maiúsculas e o índice da ocorrência atual (dá a volta). */
export interface FindState {
  query: string
  caseSensitive: boolean
  index: number
}

export const emptyFind: FindState = { query: '', caseSensitive: false, index: 0 }

/**
 * A barra de busca do app (Ctrl+F / Cmd+F): campo, contador "3 de 12", anterior e próxima
 * (Enter e Shift+Enter), diferenciar maiúsculas e fechar (Esc). A mesma na resposta, nos
 * editores, na documentação e no resto do app; quem a usa decide onde procurar.
 */
export function FindBar(props: {
  state: FindState
  onChange: (state: FindState) => void
  onClose: () => void
  /** Total de ocorrências e a atual (-1 sem ocorrência). */
  count: number
  current: number
  /** "Buscar na resposta", "Buscar no editor"... */
  label: string
  inputRef?: Ref<HTMLInputElement>
  className?: string
}) {
  const { state, onChange, count, current } = props
  const step = (delta: number) => onChange({ ...state, index: state.index + delta })
  return (
    <div
      role="search"
      className={cx('flex h-8 shrink-0 items-center gap-1 border-b border-border-subtle px-2 text-xs', props.className)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          props.onClose()
        }
      }}
    >
      <Search size={12} aria-hidden className="shrink-0 text-muted" />
      <input
        ref={props.inputRef}
        aria-label={props.label}
        placeholder="Buscar"
        className={`${controlClass} h-6 flex-1`}
        value={state.query}
        autoFocus
        spellCheck={false}
        onChange={(e) => onChange({ ...state, query: e.target.value, index: 0 })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className="w-20 shrink-0 text-center font-mono text-muted" aria-live="polite">
        {state.query ? (count ? `${current + 1} de ${count}` : 'Nenhum') : ''}
      </span>
      <IconButton label="Ocorrência anterior (Shift+Enter)" disabled={!count} onClick={() => step(-1)}>
        <ChevronUp size={14} aria-hidden />
      </IconButton>
      <IconButton label="Próxima ocorrência (Enter)" disabled={!count} onClick={() => step(1)}>
        <ChevronDown size={14} aria-hidden />
      </IconButton>
      <IconButton
        label="Diferenciar maiúsculas"
        active={state.caseSensitive}
        onClick={() => onChange({ ...state, caseSensitive: !state.caseSensitive, index: 0 })}
      >
        <CaseSensitive size={14} aria-hidden />
      </IconButton>
      <IconButton label="Fechar busca (Esc)" onClick={props.onClose}>
        <X size={14} aria-hidden />
      </IconButton>
    </div>
  )
}

/** Ctrl+F (Cmd+F no macOS); Ctrl+Shift+F é a busca no projeto. */
export function isFindShortcut(e: KeyLike): boolean {
  return matchesShortcut(e, Shortcut.find)
}
