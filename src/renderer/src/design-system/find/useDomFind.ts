import { useEffect, useRef, useState } from 'react'
import { findMatches, locateMatches, wrapIndex } from './find'
import type { FindState } from './FindBar'

/** Nomes dos realces em styles.css (`::highlight(...)`). */
const ALL = 'vv-find'
const CURRENT = 'vv-find-current'

/** Texto que a busca ignora: números de linha, ícones, diagramas e o que está escondido. */
const SKIP = 'svg, script, style, textarea, [aria-hidden="true"], [data-find-skip]'

/**
 * Busca no texto renderizado de um elemento (documentação, listas, código somente leitura) sem
 * mexer no DOM: as ocorrências viram `Range`s pintados pela CSS Custom Highlight API, então o
 * React não vê nada e o conteúdo pode mudar por baixo (a busca refaz quando o DOM muda).
 */
export function useDomFind(root: HTMLElement | null, state: FindState | null): { count: number; current: number } {
  const [found, setFound] = useState<{ ranges: Range[] }>({ ranges: [] })
  const [version, setVersion] = useState(0)
  const scrolledTo = useRef('')

  // O conteúdo mudou (documentação carregou, resposta nova, painel trocou): busca de novo.
  useEffect(() => {
    if (!root || !state) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => setVersion((v) => v + 1), 150)
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] })
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [root, !!state]) // eslint-disable-line react-hooks/exhaustive-deps

  const query = state?.query ?? ''
  const caseSensitive = state?.caseSensitive ?? false
  useEffect(() => {
    setFound({ ranges: root && query ? collectRanges(root, query, caseSensitive) : [] })
  }, [root, query, caseSensitive, version])

  const count = found.ranges.length
  const current = wrapIndex(state?.index ?? 0, count)

  useEffect(() => {
    const registry = highlights()
    if (!registry) return
    if (!state || !count) {
      registry.delete(ALL)
      registry.delete(CURRENT)
      return
    }
    registry.set(ALL, new Highlight(...found.ranges.filter((_, i) => i !== current)))
    registry.set(CURRENT, new Highlight(found.ranges[current]!))
    // Leva até a ocorrência só quando ela muda (não quando o conteúdo é refeito por baixo).
    const key = `${query}\u0000${caseSensitive}\u0000${current}`
    if (scrolledTo.current !== key) {
      scrolledTo.current = key
      scrollToRange(found.ranges[current]!)
    }
  }, [found, current, !!state]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      highlights()?.delete(ALL)
      highlights()?.delete(CURRENT)
    },
    []
  )

  return { count, current }
}

function highlights(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null
}

function collectRanges(root: HTMLElement, query: string, caseSensitive: boolean): Range[] {
  const visible = new Map<Element, boolean>()
  const isVisible = (el: Element): boolean => {
    let v = visible.get(el)
    if (v === undefined) {
      v = !el.closest(SKIP) && (el.checkVisibility?.() ?? true)
      visible.set(el, v)
    }
    return v
  }
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.parentElement && isVisible(n.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  const texts = nodes.map((n) => n.nodeValue!)
  const matches = findMatches(texts.join(''), query, caseSensitive)
  return locateMatches(
    texts.map((t) => t.length),
    matches
  ).map(([s, e]) => {
    const range = document.createRange()
    range.setStart(nodes[s.piece]!, s.offset)
    range.setEnd(nodes[e.piece]!, e.offset)
    return range
  })
}

/**
 * Rola cada contêiner rolável, de dentro para fora, até a ocorrência aparecer no meio dele. Não usa
 * scrollIntoView do elemento: num corpo grande o texto inteiro é um nó só, e o que importa é a linha.
 */
function scrollToRange(range: Range): void {
  for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el)
    const y = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight
    const x = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth
    if (!x && !y) continue
    const r = range.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    if (y && (r.top < box.top || r.bottom > box.bottom)) el.scrollTop += r.top - box.top - (el.clientHeight - r.height) / 2
    if (x && (r.left < box.left || r.right > box.right)) el.scrollLeft += r.left - box.left - (el.clientWidth - r.width) / 2
  }
}
