// Fora do index do design system: marked, DOMPurify e Mermaid só entram nos chunks dos
// módulos que mostram documentação (Catálogo e a documentação rica), nunca no cold start.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { splitFlowchart } from '@vvpost/core/docs/mermaid-split'
import { markdownWithLines } from './markdown-lines'
import { DIAGRAM_CACHE_LIMIT, LruCache, wrapTables } from './lazy-content'
import { keepHeight, watchDiagram } from './lazy-diagrams'

type MermaidApi = (typeof import('mermaid'))['default']
type IconPack = Parameters<MermaidApi['registerIconPacks']>[0][number] & {
  icons: { icons: Record<string, { body: string }> }
}

/** Miolo de SVG de um ícone pelo DOMPurify (perfil SVG): pacotes de plugin são dados de terceiros. */
export function cleanSvgBody(body: string): string {
  const svg = DOMPurify.sanitize(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`, {
    USE_PROFILES: { svg: true, svgFilters: true }
  })
  const template = document.createElement('template')
  template.innerHTML = svg
  return template.content.firstElementChild?.innerHTML ?? ''
}

/** Pacotes de ícones dos diagramas: o vv do VVPost e os dos plugins ligados, já sanitizados. */
let iconPacks: Promise<IconPack[]> | null = null
export function diagramIconPacks(): Promise<IconPack[]> {
  return (iconPacks ??= Promise.all([
    import('./vv-icons.json').then((m) => ({
      name: 'vv',
      icons: m.default as IconPack['icons']
    })),
    window.vvpost
      .diagramCatalog()
      .then((r) => (r.ok ? r.value.iconPacks : []))
      .catch(() => [])
  ]).then(([vv, plugins]) => [
    vv as IconPack,
    ...plugins.map(
      (p) =>
        ({
          name: p.prefix,
          icons: {
            ...p.icons,
            icons: Object.fromEntries(
              Object.entries(p.icons.icons).map(([k, icon]) => [k, { ...icon, body: cleanSvgBody(icon.body) }])
            )
          }
        }) as IconPack
    )
  ]))
}

// Mermaid é o maior pedaço do painel: só carrega quando o primeiro diagrama aparece.
let mermaid: Promise<MermaidApi> | null = null
let registered: IconPack[] | null = null
const getMermaid = async () => {
  const m = await (mermaid ??= import('mermaid').then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      // strict: sem HTML nem cliques nos rótulos; o SVG sai sanitizado.
      securityLevel: 'strict',
      theme: 'dark',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    })
    return m
  }))
  const packs = await diagramIconPacks()
  if (registered !== packs) {
    m.registerIconPacks(packs)
    registered = packs
  }
  return m
}

/** Lê de novo os ícones dos plugins (ligou ou desligou um plugin): vale a partir do próximo diagrama. */
export function reloadDiagramIcons(): void {
  iconPacks = null
  drawn.clear()
}

let diagramCount = 0

/** Renderiza Mermaid em SVG; com erro de sintaxe devolve a mensagem. */
export async function renderMermaid(source: string): Promise<{ svg: string } | { error: string }> {
  const id = `vvpost-mermaid-${++diagramCount}`
  try {
    const m = await getMermaid()
    const { svg } = await m.render(id, source)
    return { svg }
  } catch (err) {
    return { error: (err as Error).message || String(err) }
  } finally {
    // Com erro, o Mermaid deixa o rascunho do SVG solto no body.
    document.getElementById(`d${id}`)?.remove()
  }
}

/** SVGs da visualização por fonte (lazy-diagrams.ts): voltar a um diagrama não roda o Mermaid de novo. */
const drawn = new LruCache<string, Promise<{ svg: string } | { error: string }>>(DIAGRAM_CACHE_LIMIT)

/** renderMermaid com o cache da visualização; um pedido igual em andamento é o mesmo. */
function drawDiagram(source: string): Promise<{ svg: string } | { error: string }> {
  const hit = drawn.get(source)
  if (hit) return hit
  const promise = renderMermaid(source)
  drawn.set(source, promise)
  // Erro não fica no cache: um ícone de plugin que faltava pode chegar depois.
  void promise.then((r) => 'error' in r && drawn.delete(source))
  return promise
}

/**
 * Quem mostra a documentação e sabe editar diagramas (o módulo Documentação) passa aqui o que
 * fazer com o código de um diagrama: cada diagrama ganha um botão Editar. Sem provedor, nada muda.
 */
export const DiagramEditContext = createContext<((code: string, label: string) => void) | null>(null)

/** Âncoras dos títulos no formato do GitHub (as do sumário do documento), na ordem do texto. */
function headingAnchors(root: ParentNode): [HTMLElement, string][] {
  const seen = new Map<string, number>()
  return [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].map((h) => {
    const base = (h.textContent ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return [h, n ? `${base}-${n}` : base]
  })
}

/** Links da documentação: https abre no navegador do sistema, #âncora rola até o título; o resto não navega. */
function handleLinks(e: MouseEvent<HTMLElement>) {
  const link = (e.target as HTMLElement).closest('a')
  if (!link) return
  e.preventDefault()
  const href = link.getAttribute('href') ?? ''
  if (href.startsWith('https://')) window.open(href)
  else if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1))
    headingAnchors(e.currentTarget).find(([, a]) => a === id)?.[0].scrollIntoView({ block: 'start' })
  }
}

/** Altura sobre largura a partir da qual o diagrama não é encolhido para caber numa página. */
const TALL_DIAGRAM_RATIO = 2
/** A partir daqui, um fluxograma com etapas sai dividido (um diagrama por etapa) no PDF. */
const SPLIT_DIAGRAM_RATIO = 1.6

/**
 * HTML de impressão do Markdown (PDF da documentação): o mesmo marked + DOMPurify da tela e
 * os blocos ```mermaid já em SVG, no tema claro, para o papel.
 */
export async function markdownToPrintHtml(source: string, mermaidInit = '%%{init: {"theme": "default"}}%%'): Promise<string> {
  const root = document.createElement('div')
  root.innerHTML = DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }) as string)
  // O diagrama que já traz o próprio %%{init}%% fica com ele.
  const draw = (text: string) => renderMermaid(/^\s*%%\{\s*init/.test(text) ? text : `${mermaidInit}\n${text}`)
  const ratio = (svg: string) => {
    const [, , w, h] = (/viewBox="([^"]+)"/.exec(svg)?.[1] ?? '').split(/\s+/).map(Number)
    return w && h ? h / w : 0
  }
  const figureOf = (svg: string, caption?: string) => {
    const figure = document.createElement('figure')
    figure.className = 'mermaid-diagram'
    figure.innerHTML = svg
    if (caption) {
      const label = document.createElement('figcaption')
      label.textContent = caption
      figure.prepend(label)
    }
    // Um fluxograma muito alto encolhido para uma página fica ilegível: ele segue para a próxima
    // página no tamanho dele (o CSS do modelo trata .mermaid-tall). Uma etapa de um diagrama
    // dividido cabe numa página: encolhe, para a etapa não ser cortada de novo.
    if (!caption && ratio(svg) > TALL_DIAGRAM_RATIO) figure.classList.add('mermaid-tall')
    return figure
  }
  for (const code of root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
    const text = code.textContent ?? ''
    const result = await draw(text)
    if (!('svg' in result)) {
      const figure = document.createElement('figure')
      figure.className = 'mermaid-diagram mermaid-error'
      figure.textContent = `Diagrama Mermaid inválido: ${result.error}`
      code.parentElement!.replaceWith(figure)
      continue
    }
    // Alto demais para uma página: um diagrama por etapa (subgraph), em vez de cortar no meio.
    const parts = ratio(result.svg) > SPLIT_DIAGRAM_RATIO ? splitFlowchart(text) : null
    const drawn: Awaited<ReturnType<typeof draw>>[] = []
    // Um por vez: o Mermaid desenha num nó temporário do documento.
    for (const p of parts ?? []) drawn.push(await draw(p.source))
    if (parts && drawn.every((d) => 'svg' in d)) {
      const figures = drawn.map((d, i) => figureOf((d as { svg: string }).svg, `Etapa ${i + 1} de ${parts.length} · ${parts[i]!.title}`))
      code.parentElement!.replaceWith(...figures)
    } else code.parentElement!.replaceWith(figureOf(result.svg))
  }
  // No papel não dá para abrir um <details>: tudo sai aberto.
  for (const details of root.querySelectorAll('details')) details.open = true
  // Ids nos títulos: os links do sumário funcionam no PDF.
  for (const [h, id] of headingAnchors(root)) h.id = id
  return root.innerHTML
}

/**
 * Markdown da documentação viva. O texto vem dos arquivos do workspace (de um
 * repositório qualquer), então o HTML passa pelo DOMPurify antes de entrar no DOM.
 * Blocos ```mermaid viram diagramas.
 */
export function Markdown({ source, className = '', lines = false }: { source: string; className?: string; lines?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const edit = useContext(DiagramEditContext)
  const editRef = useRef(edit)
  editRef.current = edit
  // lines: cada bloco leva a linha do texto (data-line), para o editor ligar a prévia ao texto.
  // As tabelas vão num div.md-table, onde o content-visibility (styles.css) poupa as que estão fora da tela.
  const html = useMemo(
    () =>
      wrapTables(DOMPurify.sanitize(lines ? markdownWithLines(source) : (marked.parse(source, { async: false, gfm: true }) as string))),
    [source, lines]
  )

  // Cada ```mermaid vira um lugar reservado que só ganha o SVG perto da tela (lazy-diagrams.ts).
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const stops: (() => void)[] = []
    let n = 0
    for (const code of root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
      const pre = code.parentElement!
      const text = code.textContent ?? ''
      const label = `Diagrama ${++n}`
      const figure = document.createElement('figure')
      figure.className = 'mermaid-diagram mermaid-pending'
      figure.setAttribute('aria-label', label)
      if (pre.dataset.line) figure.dataset.line = pre.dataset.line
      if (editRef.current) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'mermaid-edit'
        button.textContent = 'Editar'
        button.title = 'Abrir no editor de diagramas'
        button.setAttribute('aria-label', `Editar ${label.toLowerCase()}`)
        button.addEventListener('click', () => editRef.current?.(text, label))
        figure.append(button)
      }
      const body = document.createElement('div')
      body.className = 'mermaid-body'
      figure.append(body)
      pre.replaceWith(figure)
      let visible = false
      stops.push(
        watchDiagram(figure, {
          show() {
            if (visible) return
            visible = true
            void drawDiagram(text).then((result) => {
              if (!visible || !figure.isConnected) return
              if ('svg' in result) {
                body.innerHTML = result.svg
                figure.classList.remove('mermaid-error')
              } else {
                body.textContent = `Diagrama Mermaid inválido: ${result.error}`
                figure.classList.add('mermaid-error')
              }
              figure.classList.remove('mermaid-pending')
              figure.style.minHeight = ''
            })
          },
          hide() {
            if (!visible) return
            visible = false
            if (!body.firstChild) return
            keepHeight(figure)
            body.replaceChildren()
            figure.classList.add('mermaid-pending')
          }
        })
      )
    }
    return () => {
      for (const stop of stops) stop()
    }
  }, [html])

  return (
    <div
      ref={ref}
      className={`markdown ${className}`}
      onClick={handleLinks}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** Diagrama gerado pelo catálogo (herança, auth). */
export function MermaidDiagram({ source, label }: { source: string; label: string }) {
  const edit = useContext(DiagramEditContext)
  const [result, setResult] = useState<{ svg: string } | { error: string } | null>(null)
  const slot = useRef<HTMLDivElement>(null)
  // Só desenha perto da tela e solta o SVG longe dela, como os diagramas do Markdown (lazy-diagrams.ts).
  useEffect(() => {
    const el = slot.current
    if (!el) return
    let visible = false
    setResult(null)
    return watchDiagram(el, {
      show() {
        if (visible) return
        visible = true
        void drawDiagram(source).then((r) => {
          if (visible) setResult(r)
        })
      },
      hide() {
        if (!visible) return
        visible = false
        keepHeight(el)
        setResult(null)
      }
    })
  }, [source])
  useLayoutEffect(() => {
    if (result && slot.current) slot.current.style.minHeight = ''
  }, [result])

  return (
    <div ref={slot} className="mermaid-slot" data-diagram={label}>
      <MermaidDiagramBody result={result} source={source} label={label} edit={edit} />
    </div>
  )
}

function MermaidDiagramBody({
  result,
  source,
  label,
  edit
}: {
  result: { svg: string } | { error: string } | null
  source: string
  label: string
  edit: ((code: string, label: string) => void) | null
}) {
  if (!result) return <div className="text-xs text-muted">Desenhando {label}…</div>
  if ('error' in result) {
    return (
      <pre className="overflow-auto rounded-md border border-danger/40 p-2 text-xs text-danger">
        {result.error}
        {'\n\n'}
        {source}
      </pre>
    )
  }
  const figure = (
    <figure
      className="mermaid-diagram"
      aria-label={label}
      role="img"
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  )
  if (!edit) return figure
  return (
    <div className="mermaid-editable">
      <button
        type="button"
        className="mermaid-edit"
        title="Abrir no editor de diagramas"
        aria-label={`Editar ${label}`}
        onClick={() => edit(source, label)}
      >
        Editar
      </button>
      {figure}
    </div>
  )
}
