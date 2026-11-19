import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { cx } from '../cx'
import { findMatches, wrapIndex } from '../find/find'
import { emptyFind, FindBar, isFindShortcut, type FindState } from '../find/FindBar'
import { jsonError, tokenizeJson, type JsonToken } from './json-tokens'

export type CodeLanguage = 'json' | 'text' | 'python' | 'javascript'

/** Acima disso o texto vai sem realce e sem formatação para não travar a interface. */
const HIGHLIGHT_LIMIT = 256 * 1024

const tokenColors: Record<JsonToken, string> = {
  key: 'text-info',
  string: 'text-success',
  number: 'text-warning',
  literal: 'text-accent',
  punct: 'text-muted',
  space: ''
}

/**
 * Editor de código do design system: o mesmo tema, fonte, numeração de linhas e atalhos para
 * JSON, scripts e corpos de resposta. Editável (textarea com Tab indentando) ou somente leitura
 * (com realce de JSON). Leve de propósito: nada de Monaco no cold start.
 */
export function CodeEditor(props: {
  value: string
  onChange?: (value: string) => void
  language?: CodeLanguage
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
  /** Barra fina acima do código (linguagem, formatar, copiar). */
  toolbar?: ReactNode
  /** Mostra o erro de sintaxe do JSON no rodapé. */
  validate?: boolean
  className?: string
  /** Conteúdo antes do código no modo leitura (aviso de corpo truncado...). */
  notice?: ReactNode
  /** Quebra as linhas longas no modo leitura (sem a numeração, que deixaria de bater). */
  wrap?: boolean
  /**
   * Conteúdo já realçado no modo leitura (o ResponseViewer marca a busca e os valores do
   * DataPicker); o texto dele deve ser `value`.
   */
  content?: ReactNode
  /** Clique dentro do código no modo leitura (delegação para o DataPicker). */
  onCodeClick?: (e: React.MouseEvent<HTMLPreElement>) => void
  onCodeContextMenu?: (e: React.MouseEvent<HTMLPreElement>) => void
  /** Botão direito (ou tecla Menu) no editor de texto: o DataPicker do body da request. */
  onEditorContextMenu?: (e: React.MouseEvent<HTMLTextAreaElement>) => void
  /** Container rolável do modo leitura, para levar a busca até a ocorrência. */
  scrollRef?: Ref<HTMLDivElement>
}) {
  const readOnly = !props.onChange
  const lines = useMemo(() => countLines(props.value), [props.value])
  const error = useMemo(
    () =>
      props.validate && props.language === 'json' && props.value.length <= HIGHLIGHT_LIMIT
        ? jsonError(props.value)
        : null,
    [props.validate, props.language, props.value]
  )
  const gutter = useRef<HTMLDivElement>(null)
  const escaped = useRef(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  // Busca do editor (Ctrl+F com o foco no texto): o textarea não aceita marcas, então as
  // ocorrências são pintadas numa camada atrás dele, com o mesmo texto transparente.
  const [find, setFind] = useState<FindState | null>(null)
  const matches = useMemo(
    () => (find?.query && !readOnly ? findMatches(props.value, find.query, find.caseSensitive) : []),
    [find?.query, find?.caseSensitive, props.value, readOnly] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const current = wrapIndex(find?.index ?? 0, matches.length)

  const syncGutter = (e: React.UIEvent<HTMLElement>) => {
    if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop
    if (backdrop.current) {
      backdrop.current.scrollTop = e.currentTarget.scrollTop
      backdrop.current.scrollLeft = e.currentTarget.scrollLeft
    }
  }

  // Leva o editor até a ocorrência atual quando ela muda.
  useLayoutEffect(() => {
    const area = textarea.current
    const mark = backdrop.current?.querySelector<HTMLElement>('[data-match-current]')
    if (!area || !mark) return
    const top = mark.offsetTop
    const left = mark.offsetLeft
    if (top < area.scrollTop || top + mark.offsetHeight > area.scrollTop + area.clientHeight) {
      area.scrollTop = top - (area.clientHeight - mark.offsetHeight) / 2
    }
    if (left < area.scrollLeft || left + mark.offsetWidth > area.scrollLeft + area.clientWidth) {
      area.scrollLeft = left - (area.clientWidth - mark.offsetWidth) / 2
    }
    if (backdrop.current) {
      backdrop.current.scrollTop = area.scrollTop
      backdrop.current.scrollLeft = area.scrollLeft
    }
    if (gutter.current) gutter.current.scrollTop = area.scrollTop
  }, [current, matches])

  const openFind = (el: HTMLTextAreaElement) => {
    // A seleção de uma linha vira o termo, como no navegador e nos editores.
    const selected = el.value.slice(el.selectionStart, el.selectionEnd)
    setFind((f) => (selected && !selected.includes('\n') ? { ...(f ?? emptyFind), query: selected, index: 0 } : (f ?? emptyFind)))
    requestAnimationFrame(() => findInput.current?.select())
  }

  const closeFind = () => {
    const match = matches[current]
    setFind(null)
    const area = textarea.current
    if (!area) return
    area.focus()
    if (match) area.setSelectionRange(match[0], match[1])
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return
    // Tab indenta; Esc antes de Tab sai do editor (o foco segue com Tab depois de um Esc).
    if (escaped.current) return
    e.preventDefault()
    const el = e.currentTarget
    const { selectionStart: start, selectionEnd: end, value } = el
    const next = `${value.slice(0, start)}  ${value.slice(end)}`
    props.onChange?.(next)
    requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2))
  }

  return (
    <div
      className={cx(
        'flex min-h-0 flex-1 flex-col overflow-hidden bg-surface font-mono text-[12px] leading-5',
        props.disabled && 'opacity-50',
        props.className
      )}
    >
      {props.toolbar && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle px-2 font-sans text-xs text-muted">
          {props.toolbar}
        </div>
      )}
      {find && !readOnly && (
        <FindBar
          label={`Buscar em ${props.ariaLabel}`}
          state={find}
          onChange={setFind}
          onClose={closeFind}
          count={matches.length}
          current={current}
          inputRef={findInput}
          className="font-sans"
        />
      )}
      <div className="flex min-h-0 flex-1">
        {!(readOnly && props.wrap) && (
          <div
            ref={gutter}
            aria-hidden
            className="w-10 shrink-0 overflow-hidden border-r border-border-subtle py-2 pr-2 text-right text-faint select-none"
          >
            {Array.from({ length: Math.min(lines, 20_000) }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
        )}
        {readOnly ? (
          <div ref={props.scrollRef} className="min-w-0 flex-1 overflow-auto" onScroll={syncGutter}>
            {props.notice}
            <pre
              aria-label={props.ariaLabel}
              tabIndex={props.onCodeClick ? 0 : undefined}
              onClick={props.onCodeClick}
              onContextMenu={props.onCodeContextMenu}
              className={cx('px-3 py-2', props.wrap ? 'whitespace-pre-wrap break-all' : 'w-max min-w-full whitespace-pre')}
            >
              {props.content ?? (props.language === 'json' ? <Highlighted text={props.value} /> : props.value)}
            </pre>
          </div>
        ) : (
          <div className="relative flex min-w-0 flex-1">
          {find?.query && matches.length > 0 && (
            <div ref={backdrop} aria-hidden data-find-skip className="pointer-events-none absolute inset-0 overflow-hidden">
              <pre className="relative w-max min-w-full px-3 py-2 leading-5 whitespace-pre text-transparent">
                <FindMarks text={props.value} matches={matches} current={current} />
              </pre>
            </div>
          )}
          <textarea
            ref={textarea}
            aria-label={props.ariaLabel}
            aria-invalid={error ? true : undefined}
            value={props.value}
            placeholder={props.placeholder}
            disabled={props.disabled}
            onChange={(e) => props.onChange!(e.target.value)}
            onKeyDown={(e) => {
              if (isFindShortcut(e)) {
                e.preventDefault()
                openFind(e.currentTarget)
                return
              }
              onKeyDown(e)
              escaped.current = e.key === 'Escape'
            }}
            onScroll={syncGutter}
            onContextMenu={props.onEditorContextMenu}
            spellCheck={false}
            wrap="off"
            className="relative min-w-0 flex-1 resize-none !rounded-none !border-0 !bg-transparent px-3 py-2 leading-5 !outline-none"
          />
          </div>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="flex h-6 shrink-0 items-center gap-2 border-t border-border-subtle px-3 font-sans text-[11px] text-danger"
        >
          JSON inválido na linha {error.line}, coluna {error.column}
        </div>
      )}
    </div>
  )
}

/** O texto do editor com as ocorrências da busca marcadas (a camada atrás do textarea). */
function FindMarks({ text, matches, current }: { text: string; matches: [number, number][]; current: number }) {
  const out: ReactNode[] = []
  let pos = 0
  matches.forEach(([s, e], i) => {
    if (s > pos) out.push(text.slice(pos, s))
    out.push(
      <mark
        key={i}
        {...(i === current && { 'data-match-current': '' })}
        className={i === current ? 'rounded-sm bg-warning/60 text-transparent outline outline-1 outline-warning' : 'rounded-sm bg-warning/25 text-transparent'}
      >
        {text.slice(s, e)}
      </mark>
    )
    pos = e
  })
  if (pos < text.length) out.push(text.slice(pos))
  return <>{out}</>
}

const Highlighted = memo(function Highlighted({ text }: { text: string }) {
  if (text.length > HIGHLIGHT_LIMIT) return <>{text}</>
  return (
    <>
      {tokenizeJson(text).map((t, i) =>
        t.type === 'space' ? (
          t.text
        ) : (
          <span key={i} className={tokenColors[t.type]}>
            {t.text}
          </span>
        )
      )}
    </>
  )
})

function countLines(text: string): number {
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** Formata JSON com 2 espaços; devolve o texto como veio quando não é JSON. */
export function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
