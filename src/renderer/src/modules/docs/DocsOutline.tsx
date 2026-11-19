import { useCallback, useEffect, useState, type RefObject } from 'react'
import { ArrowUpToLine } from 'lucide-react'
import { cx, DockablePane, IconButton } from '../../design-system'

interface Item {
  el: HTMLElement
  text: string
  level: number
}

/** Abaixo disto o documento cabe em pouco mais de uma tela: sem sumário no texto, a barra não aparece. */
const LONG_DOCUMENT = 2
/** Distância do topo da área de leitura a partir da qual um título conta como a seção atual. */
const READING_LINE = 96

/** Texto de um título sem os botões que a tela acrescenta (o "Testar" dos endpoints). */
const headingText = (h: Element) =>
  [...h.childNodes]
    .filter((n) => !(n instanceof HTMLButtonElement))
    .map((n) => n.textContent)
    .join('')
    .trim()

const isSummary = (h: Element) => /^(\d+(\.\d+)*\.?\s+)?sumário$/i.test(headingText(h))

/**
 * Sumário fixo ao lado do documento do projeto: aparece quando o sumário escrito no texto sai da
 * área visível (ou o documento é longo e não tem sumário), com os títulos de seção e a seção em
 * leitura destacada. Fica no mesmo lugar e largura do sumário da referência gerada.
 */
export function DocsOutline({ scroller, content, source }: { scroller: RefObject<HTMLElement>; content: RefObject<HTMLElement>; source: string }) {
  const [items, setItems] = useState<Item[]>([])
  const [summary, setSummary] = useState<HTMLElement | null>(null)
  // Até o observador responder, o sumário do texto conta como visível: a barra não pisca ao abrir.
  const [summaryVisible, setSummaryVisible] = useState(true)
  const [long, setLong] = useState(false)
  const [active, setActive] = useState(-1)

  // Títulos do documento: relidos quando o Markdown monta (diagramas e botões mudam o DOM depois).
  useEffect(() => {
    const root = content.current
    if (!root) return
    let frame = 0
    const read = () => {
      frame = 0
      const headings = [...root.querySelectorAll<HTMLElement>('.markdown h2, .markdown h3')]
      const found = headings.find(isSummary) ?? null
      setSummary(found)
      setItems(
        headings
          .filter((h) => h !== found && !h.closest('figure'))
          .map((el) => ({ el, text: headingText(el), level: el.tagName === 'H2' ? 2 : 3 }))
          .filter((i) => i.text)
      )
      const s = scroller.current
      setLong(!!s && s.scrollHeight > s.clientHeight * LONG_DOCUMENT)
    }
    read()
    const observer = new MutationObserver(() => {
      frame ||= requestAnimationFrame(read)
    })
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [content, scroller, source])

  // O sumário do texto (o título e a lista logo abaixo) na área visível.
  useEffect(() => {
    const root = scroller.current
    if (!summary || !root) return
    const parts = [summary, summary.nextElementSibling].filter((e): e is Element => !!e)
    const shown = new Set<Element>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) shown.add(e.target)
          else shown.delete(e.target)
        }
        setSummaryVisible(shown.size > 0)
      },
      { root }
    )
    for (const p of parts) observer.observe(p)
    return () => observer.disconnect()
  }, [summary, scroller])

  // A seção em leitura: o último título que já passou da linha de leitura.
  useEffect(() => {
    const root = scroller.current
    if (!root || !items.length) return
    let frame = 0
    const update = () => {
      frame = 0
      const top = root.getBoundingClientRect().top + READING_LINE
      let current = -1
      for (const [i, item] of items.entries()) {
        if (item.el.getBoundingClientRect().top <= top) current = i
        else break
      }
      setActive(current)
    }
    update()
    const onScroll = () => {
      frame ||= requestAnimationFrame(update)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [items, scroller])

  const go = useCallback((el: Element) => el.scrollIntoView({ block: 'start' }), [])

  const show = items.length >= 2 && (summary ? !summaryVisible : long)
  if (!show) return null
  return (
    <DockablePane
      as="nav"
      id="docs.toc"
      title="Sumário"
      dockLabel="o sumário"
      label="Largura do sumário"
      defaultSize={256}
      min={180}
      max={560}
      className="overflow-auto border-r border-border-subtle p-2 text-xs"
      aria-label="Sumário fixo do documento"
      actions={
        summary && (
          <IconButton label="Ir para o sumário do texto" onClick={() => go(summary)}>
            <ArrowUpToLine size={14} aria-hidden />
          </IconButton>
        )
      }
    >
      <ul className="flex flex-col gap-0.5">
        {items.map((item, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => go(item.el)}
              aria-current={i === active ? 'location' : undefined}
              title={item.text}
              style={{ paddingLeft: `${0.5 + (item.level - 2) * 0.75}rem` }}
              className={cx(
                'flex w-full items-center rounded-[var(--radius-control)] py-1 pr-2 text-left hover:bg-elevated hover:text-fg',
                i === active ? 'bg-elevated font-medium text-fg' : item.level === 2 ? 'text-fg' : 'text-muted'
              )}
            >
              <span className="truncate">{item.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </DockablePane>
  )
}
