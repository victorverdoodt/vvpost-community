import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { monaco } from './monaco-core'
import type { InlinePreview } from './source-sync'

/** Altura do trecho recolhido: umas seis linhas de texto, para o documento não virar só prévia. */
const COLLAPSED_PX = 132
/** Expandido, o trecho para aqui (um conector inteiro): o resto fica na prévia. */
const EXPANDED_PX = 1600

interface Zone {
  id: string
  key: string
  decoration: string
  expanded: boolean
  node: HTMLElement
  card: HTMLElement
  zone: monaco.editor.IViewZone
}

const KIND_LABEL: Record<string, string> = {
  include: 'trecho de outra doc',
  connector: 'conector',
  endpoint: 'endpoint',
  request: 'request',
  diagram: 'diagrama',
  codemap: 'mapa do código',
  tokens: 'tokens da marca'
}

function previewHtml(markdown: string): string {
  const root = document.createElement('div')
  root.innerHTML = DOMPurify.sanitize(marked.parse(markdown || '_A diretiva não monta nenhum texto._', { async: false, gfm: true }) as string)
  // O diagrama aparece desenhado na prévia; aqui, só o aviso de que ele está ali.
  for (const code of root.querySelectorAll('pre > code.language-mermaid')) {
    const note = document.createElement('p')
    note.className = 'doc-inline-note'
    note.textContent = `Diagrama Mermaid (${(code.textContent ?? '').trim().split('\n').length} linhas): desenhado na prévia`
    code.parentElement!.replaceWith(note)
  }
  // Âncoras e links não navegam de dentro do editor.
  for (const a of root.querySelectorAll('a')) a.removeAttribute('href')
  return root.innerHTML
}

/**
 * Prévias inline das diretivas no texto cru: embaixo de cada {{> include ...}}, {{> connector ...}}
 * e companhia, o trecho que ela monta, como as "view zones" do VS Code (o peek de definição, o diff
 * inline): o texto em volta continua editável e o trecho não entra no arquivo. O trecho vem do
 * documento já montado para a prévia, então segue a herança e os includes aninhados sem montar de novo.
 */
export function inlinePreviewZones(
  editor: monaco.editor.IStandaloneCodeEditor,
  options: { canOpen(line: number): string | null; open(line: number): void }
) {
  const model = editor.getModel()!
  let zones: Zone[] = []
  // Mede fora das zonas (o Monaco esconde as que estão fora da tela): mesmo CSS, mesma largura.
  const measurer = document.createElement('div')
  measurer.className = 'doc-inline'
  measurer.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:0;top:0'
  editor.getContainerDomNode().appendChild(measurer)

  const width = () => {
    const l = editor.getLayoutInfo()
    return Math.max(160, l.contentWidth - l.verticalScrollbarWidth - 24)
  }
  // Escondido (outra aba na frente), o Monaco fica com uns poucos pixels (não zero): abaixo disto, o
  // editor não está à vista, e a zona fica com a altura de antes até ser medida quando ele aparecer.
  let pending = false
  const shown = () => {
    const l = editor.getLayoutInfo()
    return l.height >= 40 && l.contentWidth >= 120
  }
  const heightOf = (z: Pick<Zone, 'card' | 'zone'>) => {
    if (!shown()) {
      pending = true
      return z.zone.heightInPx ?? COLLAPSED_PX
    }
    const clone = z.card.cloneNode(true) as HTMLElement
    clone.style.width = `${width()}px`
    measurer.replaceChildren(clone)
    const h = clone.offsetHeight
    measurer.replaceChildren()
    if (!h) pending = true
    return h ? Math.min(EXPANDED_PX, h) + 6 : (z.zone.heightInPx ?? COLLAPSED_PX)
  }
  // O que a pessoa via da última vez que o editor apareceu: a linha do cursor (ou, com o cursor fora
  // da vista, a primeira linha) e a distância dela ao topo. Escondido (outra aba na frente), o Monaco
  // fica estreito, quebra cada linha em muitas e perde a rolagem; ao voltar, o texto volta para cá.
  let anchor: { line: number; offset: number } | null = null
  let hidden = false
  const capture = () => {
    if (hidden || !shown()) return
    const height = editor.getLayoutInfo().height
    const cursor = editor.getPosition()?.lineNumber ?? 1
    const offset = editor.getTopForLineNumber(cursor) - editor.getScrollTop()
    if (offset >= -editor.getOption(monaco.editor.EditorOption.lineHeight) && offset <= height) anchor = { line: cursor, offset }
    else {
      const line = editor.getVisibleRanges()[0]?.startLineNumber ?? 1
      anchor = { line, offset: editor.getTopForLineNumber(line) - editor.getScrollTop() }
    }
  }
  const restore = (a: typeof anchor) => a && editor.setScrollTop(editor.getTopForLineNumber(a.line) - a.offset)
  const listeners = [editor.onDidScrollChange(capture), editor.onDidChangeCursorPosition(capture)]
  /**
   * Muda as zonas sem mexer no que a pessoa vê: a linha do cursor fica no mesmo lugar da tela, e um
   * trecho que entra (ou cresce) acima dela não empurra o texto que está sendo digitado para fora.
   */
  const keepCursor = (change: () => void) => {
    capture()
    const a = anchor
    change()
    if (!hidden) restore(a)
  }
  const relayout = (list: Zone[]) =>
    keepCursor(() =>
      editor.changeViewZones((acc) => {
        for (const z of list) {
          z.card.style.width = `${width()}px`
          z.zone.heightInPx = heightOf(z)
          acc.layoutZone(z.id)
        }
      })
    )

  const build = (p: InlinePreview): Omit<Zone, 'id' | 'decoration'> => {
    const node = document.createElement('div')
    node.className = 'doc-inline'
    const card = document.createElement('div')
    card.className = 'doc-inline-card'
    card.dataset.collapsed = 'true'
    const head = document.createElement('div')
    head.className = 'doc-inline-head'
    const title = document.createElement('span')
    const lines = p.markdown ? p.markdown.split('\n').length : 0
    title.textContent = `↳ ${KIND_LABEL[p.kind] ?? p.kind} · ${lines === 1 ? '1 linha' : `${lines} linhas`} na prévia`
    head.append(title)
    const body = document.createElement('div')
    body.className = 'doc-inline-body markdown'
    body.innerHTML = previewHtml(p.markdown)
    card.append(head, body)
    node.append(card)
    const zone: monaco.editor.IViewZone = { afterLineNumber: p.line, heightInPx: COLLAPSED_PX, domNode: node, suppressMouseDown: true }
    return { key: `${p.directive}\n${p.markdown}`, expanded: false, node, card, zone }
  }
  const addButtons = (z: Zone) => {
    const head = z.card.querySelector('.doc-inline-head')!
    const button = (label: string, title: string, run: () => void) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.title = title
      b.addEventListener('mousedown', (e) => e.stopPropagation())
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        run()
      })
      head.append(b)
      return b
    }
    const toggle = button('Mostrar tudo', 'Mostra o trecho inteiro aqui no texto', () => {
      z.expanded = !z.expanded
      z.card.dataset.collapsed = String(!z.expanded)
      toggle.textContent = z.expanded ? 'Recolher' : 'Mostrar tudo'
      relayout([z])
    })
    const line = () => model.getDecorationRange(z.decoration)?.startLineNumber ?? z.zone.afterLineNumber
    const target = options.canOpen(z.zone.afterLineNumber)
    if (target) button('Abrir', `Abrir ${target} (Ctrl+clique na diretiva)`, () => options.open(line()))
  }

  const clear = () => {
    editor.changeViewZones((acc) => zones.forEach((z) => acc.removeZone(z.id)))
    model.deltaDecorations(
      zones.map((z) => z.decoration),
      []
    )
    zones = []
  }

  // A largura mudou (a divisão arrastada, a janela): as alturas mudam junto. Escondido (largura 0),
  // nada muda: a volta acha as zonas como estavam.
  let measuredWidth = 0
  const layoutListener = editor.onDidLayoutChange((l) => {
    if (!shown()) {
      hidden = true
      return
    }
    const back = hidden
    hidden = false
    if (l.contentWidth !== measuredWidth || pending) {
      measuredWidth = l.contentWidth
      pending = false
      if (zones.length) relayout(zones)
    }
    if (back) restore(anchor)
  })

  return {
    /** Troca as prévias; null tira todas. As que não mudaram ficam (e lembram se estavam abertas). */
    set(list: InlinePreview[] | null) {
      if (!list) return clear()
      const keep: Zone[] = []
      const stale: Zone[] = []
      const wanted = new Map(list.map((p) => [`${p.line}\n${p.directive}\n${p.markdown}`, p]))
      for (const z of zones) {
        const at = model.getDecorationRange(z.decoration)?.startLineNumber
        const k = `${at}\n${z.key}`
        if (at && wanted.has(k)) {
          keep.push(z)
          wanted.delete(k)
        } else stale.push(z)
      }
      const fresh = [...wanted.values()].map(build)
      if (!stale.length && !fresh.length) return
      keepCursor(() => editor.changeViewZones((acc) => {
        stale.forEach((z) => acc.removeZone(z.id))
        for (const f of fresh) {
          f.card.style.width = `${width()}px`
          f.zone.heightInPx = heightOf(f)
          const id = acc.addZone(f.zone)
          const [decoration] = model.deltaDecorations([], [{ range: new monaco.Range(f.zone.afterLineNumber, 1, f.zone.afterLineNumber, 1), options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }])
          const z = { ...f, id, decoration: decoration! }
          addButtons(z)
          keep.push(z)
        }
      }))
      model.deltaDecorations(
        stale.map((z) => z.decoration),
        []
      )
      zones = keep
    },
    dispose() {
      clear()
      layoutListener.dispose()
      listeners.forEach((l) => l.dispose())
      measurer.remove()
    }
  }
}
