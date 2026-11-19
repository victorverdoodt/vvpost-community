import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocsEditorHandle } from './monaco-docs'
import { inlinePreviews, lineForPreviewTop, placePreviews, previewTopForLine, sourceRange, syncAnchors, type SyncAnchor } from './source-sync'

/** O documento montado que está na prévia, com o texto de onde saiu e o mapa das linhas. */
export interface SyncedPreview {
  markdown: string
  sourceLines?: number[]
  /** O texto do editor que foi montado. */
  from: string
}

const INLINE_KEY = 'vvpost.docs.inlinePreviews'

/** Prévias inline das diretivas ligadas ou não, lembrado para os dois editores. */
export function useInlinePreviews(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(INLINE_KEY) !== 'off'
    } catch {
      return true
    }
  })
  return [
    on,
    (v) => {
      setOn(v)
      try {
        localStorage.setItem(INLINE_KEY, v ? 'on' : 'off')
      } catch {
        // Sem armazenamento: vale até fechar a aba.
      }
    }
  ]
}

/** Depois de um clique na prévia, o texto rola suave: a prévia fica onde está nesse meio tempo. */
const CLICK_MS = 600

type Block = SyncAnchor & { el: HTMLElement }

/**
 * Liga a prévia ao texto cru, como a prévia de Markdown do VS Code (data-line em cada bloco):
 * a rolagem de um lado leva o outro ao mesmo trecho, o clique num bloco da prévia mostra e destaca
 * as linhas dele no texto (duplo clique põe o cursor lá), o bloco da linha do cursor fica marcado
 * na prévia, e o texto mostra embaixo de cada diretiva o trecho que ela monta.
 */
export function usePreviewSync(options: {
  editor: React.MutableRefObject<DocsEditorHandle | null>
  /** Muda quando o Monaco é criado. */
  editorReady: number
  compiled: SyncedPreview | null
  /** Texto e prévia lado a lado: a rolagem sincroniza. */
  split: boolean
  inline: boolean
}) {
  const { editor, editorReady, compiled, split, inline } = options
  // O contêiner que rola a prévia: estado, porque ele aparece e some (a prévia em PDF não tem blocos).
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const sourceLines = compiled?.sourceLines

  // As prévias inline saem do documento já montado, postas nas linhas do texto de agora.
  useEffect(() => {
    const e = editor.current
    if (!e) return
    if (!inline || !compiled || !sourceLines) return e.setInlinePreviews(null)
    e.setInlinePreviews(placePreviews(inlinePreviews(compiled.from, compiled.markdown, sourceLines), e.value()))
  }, [editor, editorReady, compiled, sourceLines, inline])

  // Os blocos da prévia e as alturas: refeitos quando a prévia muda de tamanho (um diagrama desenhado).
  const blocks = useRef<Block[] | null>(null)
  const anchors = useCallback((): Block[] => {
    if (!root || !sourceLines) return []
    if (blocks.current) return blocks.current
    const base = root.getBoundingClientRect().top - root.scrollTop
    const found = [...root.querySelectorAll<HTMLElement>('[data-line]')].map((el) => ({ line: Number(el.dataset.line), top: el.getBoundingClientRect().top - base, el }))
    const list: Block[] = syncAnchors(found, sourceLines).map((a) => ({ line: a.line, top: a.top, el: a.block.el }))
    // O fim do texto amarra no fim da prévia.
    const lines = editor.current?.value().split('\n').length ?? 0
    if (list.length && lines + 1 > list.at(-1)!.line) list.push({ line: lines + 1, top: root.scrollHeight, el: root })
    return (blocks.current = list)
  }, [root, sourceLines, editor])
  useEffect(() => {
    blocks.current = null
    if (!root) return
    const observer = new ResizeObserver(() => (blocks.current = null))
    observer.observe(root)
    for (const child of root.children) observer.observe(child)
    return () => observer.disconnect()
  }, [root, compiled, split])

  // Rolagem: um lado rola, o outro acompanha. A rolagem que um lado causou no outro chega de volta
  // como um evento de rolagem: ele é reconhecido pela posição esperada e não volta (como o
  // scrollDisabledCount da prévia do VS Code). Depois de um clique na prévia, o texto rola suave até
  // a linha: esses eventos também não mexem na prévia.
  const echo = useRef<{ editor: number | null; preview: number | null; until: number }>({ editor: null, preview: null, until: 0 })
  useEffect(() => {
    const e = editor.current
    if (!e || !root || !split || !sourceLines) return
    let frame = 0
    // O Monaco avisa a rolagem dentro do próprio setScrollTop: o aviso que chega enquanto a prévia
    // rola o texto é o eco.
    let driving = false
    let heard = false
    const offEditor = e.onScroll((line, atEnd, scrollTop) => {
      const wait = echo.current
      if (driving) {
        heard = true
        return
      }
      if (wait.editor !== null && Math.abs(scrollTop - wait.editor) < 2) {
        wait.editor = null
        return
      }
      if (performance.now() < wait.until) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        // O fim de um lado é o fim do outro, mesmo com alturas que não batem no último trecho.
        const top = atEnd ? root.scrollHeight : previewTopForLine(anchors(), line)
        if (top === null) return
        const before = root.scrollTop
        root.scrollTop = top
        wait.preview = root.scrollTop !== before ? root.scrollTop : null
      })
    })
    const onPreview = () => {
      const wait = echo.current
      if (wait.preview !== null && Math.abs(root.scrollTop - wait.preview) < 2) {
        wait.preview = null
        return
      }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const atEnd = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2
        const line = atEnd ? Number.MAX_SAFE_INTEGER : lineForPreviewTop(anchors(), root.scrollTop)
        if (line === null) return
        driving = true
        heard = false
        const after = e.scrollToLine(line)
        driving = false
        wait.editor = heard ? null : after
      })
    }
    root.addEventListener('scroll', onPreview, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      offEditor()
      root.removeEventListener('scroll', onPreview)
    }
  }, [editor, editorReady, root, split, sourceLines, anchors])

  // O bloco da linha do cursor fica marcado na prévia.
  useEffect(() => {
    const e = editor.current
    if (!e || !sourceLines) return
    // Todos os blocos da linha: o trecho inteiro de um include fica marcado, não só o primeiro bloco.
    let marked: HTMLElement[] = []
    let markedLine = 0
    const mark = (line: number) => {
      const block = anchors().findLast((b) => b.line <= line && b.el !== root)
      if ((block?.line ?? 0) === markedLine) return
      marked.forEach((el) => el.classList.remove('doc-active-block'))
      markedLine = block?.line ?? 0
      marked = root && block ? [...root.querySelectorAll<HTMLElement>('[data-line]')].filter((el) => sourceLines[Number(el.dataset.line)] === block.line) : []
      marked.forEach((el) => el.classList.add('doc-active-block'))
    }
    const off = e.onCursorLine(mark)
    return () => {
      off()
      marked.forEach((el) => el.classList.remove('doc-active-block'))
    }
  }, [editor, editorReady, root, sourceLines, anchors])

  /** As linhas do texto de um bloco da prévia clicado; null fora de um bloco ou num link. */
  const rangeAt = (target: EventTarget | null) => {
    const el = target instanceof Element ? target : null
    if (!el || !sourceLines || el.closest('a, button, summary, input, select, textarea')) return null
    const block = el.closest<HTMLElement>('[data-line]')
    const e = editor.current
    if (!block || !e) return null
    return sourceRange(sourceLines, Number(block.dataset.line), e.value())
  }
  return {
    /** Vai no ref do contêiner que rola a prévia. */
    previewRef: setRoot,
    /** Clique num bloco da prévia: o texto mostra e destaca as linhas dele, sem tirar o foco da prévia. */
    onPreviewClick(event: React.MouseEvent) {
      if (event.detail > 1 || window.getSelection()?.toString()) return
      const range = rangeAt(event.target)
      if (!range) return
      echo.current.until = performance.now() + CLICK_MS
      editor.current?.flash(range.from, range.to)
    },
    /** Duplo clique: o cursor vai para a linha do bloco, para editar ali. Devolve a linha (ou null). */
    lineAt(event: React.MouseEvent): number | null {
      return rangeAt(event.target)?.from ?? null
    }
  }
}
