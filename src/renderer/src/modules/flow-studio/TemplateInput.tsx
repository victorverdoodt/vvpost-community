import { createContext, useContext, useRef, useState, type KeyboardEvent } from 'react'
import { completionsAt, type Completion, type KnownOutputs } from './model'

/**
 * Como o Visual Data Picker escreve a referência no campo: {{ $nodes... }}, $nodes...,
 * nodes[...] (Python) ou nodes.X... (script JavaScript de plugin).
 */
export type PickFormat = 'template' | 'path' | 'python' | 'javascript'

export interface PickTarget {
  format: PickFormat
  label: string
  insert(text: string): void
}

/** O último campo focado recebe o que for clicado no Visual Data Picker. */
export const PickTargetContext = createContext<(target: PickTarget) => void>(() => undefined)

const fieldClass = 'w-full border px-2 py-1 font-mono text-xs'

interface Props {
  value: string
  onChange(value: string): void
  ancestors: readonly string[]
  outputs: KnownOutputs
  label: string
  multiline?: boolean
  rows?: number
  placeholder?: string
  format?: PickFormat
}

/**
 * Campo de texto com autocomplete de {{ $nodes.Nome.data.campo }}: ao digitar "{{" ou
 * "$nodes." aparecem os nós anteriores e os campos da última execução. Focado, é o
 * destino do Visual Data Picker.
 */
export function TemplateInput({
  value,
  onChange,
  ancestors,
  outputs,
  label,
  multiline,
  rows = 4,
  placeholder,
  format = 'template'
}: Props) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const setTarget = useContext(PickTargetContext)
  const [menu, setMenu] = useState<{ replaceFrom: number; items: Completion[]; active: number } | null>(null)

  const refresh = (text = ref.current?.value ?? value) => {
    const el = ref.current
    if (!el || document.activeElement !== el) return setMenu(null)
    const caret = el.selectionStart ?? text.length
    const found = completionsAt(text.slice(0, caret), ancestors, outputs)
    setMenu(found && found.items.length ? { ...found, active: 0 } : null)
  }

  /** Troca value[from..caret] por `text` e põe o cursor no fim. */
  const replace = (from: number, text: string, closeTemplate = false) => {
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const tail = value.slice(caret)
    // Completar o nome logo depois de "{{" fecha a referência, se ela ainda não está fechada.
    const suffix = closeTemplate && !/^\s*\}\}/.test(tail) ? ' }}' : ''
    const next = value.slice(0, from) + text + suffix + tail
    onChange(next)
    const at = from + text.length
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at, at)
      refresh(next)
    })
  }

  const accept = (item: Completion) => {
    if (!menu) return
    // Só as sugestões logo depois de "{{" trazem o "$nodes." inteiro.
    replace(menu.replaceFrom, item.insert, item.insert.startsWith('$nodes.'))
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!menu) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setMenu({ ...menu, active: (menu.active + delta + menu.items.length) % menu.items.length })
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      accept(menu.items[menu.active]!)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setMenu(null)
    }
  }

  const onFocus = () => {
    setTarget({
      format,
      label,
      insert: (text) => {
        const el = ref.current
        const start = el?.selectionStart ?? value.length
        const end = el?.selectionEnd ?? start
        const current = el?.value ?? value
        const next = current.slice(0, start) + text + current.slice(end)
        onChange(next)
        requestAnimationFrame(() => {
          el?.focus()
          el?.setSelectionRange(start + text.length, start + text.length)
        })
      }
    })
    refresh()
  }

  const common = {
    ref,
    value,
    'aria-label': label,
    placeholder,
    spellCheck: false,
    className: fieldClass,
    onChange: (e: { target: { value: string } }) => {
      onChange(e.target.value)
      refresh(e.target.value)
    },
    onKeyDown,
    onKeyUp: (e: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) refresh()
    },
    onClick: () => refresh(),
    onFocus,
    onBlur: () => setTimeout(() => setMenu(null), 150)
  }

  return (
    <div className="relative">
      {multiline ? <textarea {...common} rows={rows} /> : <input {...common} />}
      {menu && (
        <ul
          role="listbox"
          aria-label="Sugestões de $nodes"
          className="absolute left-0 z-20 mt-1 max-h-56 min-w-56 overflow-auto rounded-md border border-border bg-panel py-1 text-xs shadow-lg"
        >
          {menu.items.map((item, i) => (
            <li
              key={item.label}
              role="option"
              aria-selected={i === menu.active}
              onMouseDown={(e) => {
                e.preventDefault()
                accept(item)
              }}
              className={`flex cursor-pointer justify-between gap-4 px-2 py-1 font-mono ${i === menu.active ? 'bg-border' : ''}`}
            >
              <span>{item.label}</span>
              {item.detail && <span className="truncate text-muted">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
