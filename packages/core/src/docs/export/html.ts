import { createHash } from 'node:crypto'
import { escapeHtml } from '../theme'
import { plain } from '../publish/blocks'
import type { AlertKind, PublishBlock, PublishBundle, PublishInline, PublishTreeNode } from '../publish/types'
import { SITE_CSS, SITE_JS } from './html-assets'
import type { ChangelogEntry, ChangelogRef, DocsExporter, ExportContext, ExportFile } from './types'

const esc = escapeHtml
/** Teto do texto de cada página no índice da busca. */
const SEARCH_TEXT = 4000
const ALERT_TITLE: Record<AlertKind, string> = { note: 'Nota', tip: 'Dica', important: 'Importante', warning: 'Atenção', caution: 'Cuidado' }
/** Nomes que o site usa; uma página com o mesmo slug ganha um sufixo. */
const RESERVED = new Set(['index', 'mudancas', '404'])
export const CHANGELOG_FILE = 'mudancas.html'
/** O Mermaid que desenha no navegador os diagramas sem imagem; servido junto com o site, sem CDN. */
export const MERMAID_FILE = 'assets/mermaid.min.js'

/**
 * O exportador "html": a documentação como site estático, sem servidor e sem nada externo.
 * Uma página .html por página do pacote (a primeira é o index.html), navegação lateral com a
 * estrutura do vvpost.publish.json, sumário de cada página, busca no próprio site, diagramas
 * como imagens em assets/ e a página Mudanças com o histórico das exportações. Abre direto do
 * disco (file://) e serve em qualquer hospedagem estática, num portal de parceiros ou no
 * Backstage TechDocs (site.backstage).
 */
export const htmlExporter: DocsExporter = {
  id: 'html',
  title: 'Site HTML',
  description: 'Site estático numa pasta: navegação, busca, diagramas e o histórico de mudanças.',
  render: async (bundle, ctx) => renderHtmlSite(bundle, ctx)
}

interface SitePage {
  node: PublishTreeNode
  file: string
  /** Títulos das pastas e páginas acima. */
  path: string[]
}

/** O arquivo de cada página: a primeira é o index.html; as outras, um nome estável pela chave. */
export function siteFiles(nodes: PublishTreeNode[]): Map<string, string> {
  const files = new Map<string, string>()
  const used = new Set<string>()
  const walk = (list: PublishTreeNode[]) => {
    for (const n of list) {
      if (n.kind === 'page') {
        if (!files.size) {
          files.set(n.key, 'index.html')
          used.add('index')
        } else {
          // file:docs/guias/inicio.md → guias-inicio; connector:billing → connector-billing (connector:connector.x → connector-x).
          const base = slugify(n.key.replace(/^(file|page):(docs\/)?/, '').replace(/\.md(#|$)/i, '$1')).replace(/^([a-z0-9]+)-\1-/, '$1-') || 'pagina'
          let slug = RESERVED.has(base) ? `${base}-pagina` : base
          for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`
          used.add(slug)
          files.set(n.key, `${slug}.html`)
        }
      }
      walk(n.children)
    }
  }
  walk(nodes)
  return files
}

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
}

export function renderHtmlSite(bundle: PublishBundle, ctx: Pick<ExportContext, 'changelog' | 'mermaidScript'>): ExportFile[] {
  const files = siteFiles(bundle.nodes)
  const pages: SitePage[] = []
  const walk = (list: PublishTreeNode[], path: string[]) => {
    for (const n of list) {
      const file = files.get(n.key)
      if (file) pages.push({ node: n, file, path })
      walk(n.children, [...path, n.title])
    }
  }
  walk(bundle.nodes, [])
  const assets = new Map(bundle.assets.filter((a) => a.data).map((a) => [a.id, a]))
  const title = bundle.meta?.title ?? bundle.project
  const changelog = bundle.site?.changelog !== false
  const baseUrl = bundle.site?.baseUrl?.replace(/\/+$/, '')
  const out: ExportFile[] = []
  const search: { t: string; f: string; p: string; x: string; h: [string, string][] }[] = []

  // Sem o mermaid.min.js, o diagrama sem imagem fica como código.
  const live = ctx.mermaidScript !== undefined
  let drawsLive = false
  const ctxFor = (current: string) => ({ bundle, files, assets, current, live })
  const shell = (current: string, pageTitle: string, main: string, toc: [number, string, string][], mermaid = false) =>
    layout({ bundle, title, pageTitle, current, nav: renderNav(bundle.nodes, files, current), main, toc, changelog, baseUrl, mermaid })

  pages.forEach((p, i) => {
    const r = ctxFor(p.file)
    const blocks = p.node.page?.blocks ?? []
    const headings = collectHeadings(blocks)
    const body = blocks.length
      ? renderBlocks(blocks, r)
      : `<ul class="vv-children">${p.node.children.map((c) => childLink(c, files)).join('')}</ul>`
    const crumbs = p.path.length ? `<nav class="vv-crumbs" aria-label="Caminho">${p.path.map((t) => `<span>${esc(t)}</span>`).join('<span aria-hidden="true">/</span>')}</nav>` : ''
    const prev = pages[i - 1]
    const next = pages[i + 1]
    const pager = `<nav class="vv-pager" aria-label="Páginas">${prev ? `<a class="vv-prev" href="${prev.file}"><small>Anterior</small>${esc(prev.node.title)}</a>` : '<span></span>'}${next ? `<a class="vv-next" href="${next.file}"><small>Próxima</small>${esc(next.node.title)}</a>` : ''}</nav>`
    const main = `${crumbs}<h1 id="vv-titulo">${esc(p.node.title)}</h1>${body}${pager}`
    const mermaid = live && body.includes('class="vv-mermaid"')
    drawsLive ||= mermaid
    out.push({ path: p.file, page: p.node.key, data: shell(p.file, p.node.title, main, headings.filter(([l]) => l <= 3), mermaid) })
    search.push({
      t: p.node.title,
      f: p.file,
      p: p.path.join(' / '),
      x: blocksText(blocks).slice(0, SEARCH_TEXT),
      h: headings.filter(([l]) => l <= 3).map(([, a, t]) => [a, t])
    })
  })

  if (!pages.length) {
    out.push({ path: 'index.html', data: shell('index.html', title, `<h1 id="vv-titulo">${esc(title)}</h1><p>A estrutura não tem páginas.</p>`, []) })
  }
  if (changelog) {
    out.push({ path: CHANGELOG_FILE, data: shell(CHANGELOG_FILE, 'Mudanças', renderChangelog(ctx.changelog, files), []) })
  }
  out.push({ path: '404.html', data: shell('404.html', 'Página não encontrada', '<h1 id="vv-titulo">Página não encontrada</h1><p><a href="index.html">Voltar para o início</a></p>', []) })

  out.push({ path: 'assets/vvpost-site.css', data: siteCss(bundle.meta?.primary) })
  out.push({ path: 'assets/vvpost-site.js', data: SITE_JS })
  if (drawsLive) out.push({ path: MERMAID_FILE, data: ctx.mermaidScript! })
  // Um script, não um JSON: a busca funciona também aberta do disco (file:// não deixa ler JSON).
  out.push({ path: 'assets/vvpost-search.js', data: `window.VVPOST_SEARCH=${JSON.stringify(search).replace(/</g, '\\u003c')};\n` })
  const used = new Set<string>()
  for (const p of pages) collectAssets(p.node.page?.blocks ?? [], used)
  if (bundle.meta?.logo) used.add(bundle.meta.logo)
  for (const id of [...used].sort()) {
    const a = assets.get(id)
    if (a?.data) out.push({ path: `assets/${id}`, data: a.data })
  }

  if (baseUrl) {
    const urls = [...pages.map((p) => p.file), ...(changelog ? [CHANGELOG_FILE] : [])]
    out.push({
      path: 'sitemap.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(`${baseUrl}/${u}`)}</loc></url>`).join('\n')}\n</urlset>\n`
    })
  }
  if (bundle.site?.backstage) {
    const names = [...out.map((f) => f.path), 'techdocs_metadata.json'].sort()
    const etag = createHash('sha256')
      .update(JSON.stringify(out.map((f) => [f.path, createHash('sha256').update(f.data).digest('hex')])))
      .digest('hex')
      .slice(0, 40)
    out.push({
      path: 'techdocs_metadata.json',
      data: `${JSON.stringify(
        {
          site_name: title,
          site_description: bundle.meta?.subtitle ?? `Documentação de ${bundle.project}`,
          etag,
          build_timestamp: Math.floor(Date.parse(bundle.generatedAt) / 1000),
          files: names
        },
        null,
        2
      )}\n`
    })
  }
  return out
}

interface RenderCtx {
  bundle: PublishBundle
  files: Map<string, string>
  assets: Map<string, unknown>
  /** O site leva o mermaid.min.js: diagrama sem imagem é desenhado no navegador. */
  live?: boolean
}

function layout(o: {
  bundle: PublishBundle
  title: string
  pageTitle: string
  current: string
  nav: string
  main: string
  toc: [number, string, string][]
  changelog: boolean
  baseUrl?: string
  /** A página tem diagrama para desenhar no navegador. */
  mermaid?: boolean
}): string {
  const { bundle } = o
  const logo = bundle.meta?.logo ? `<img class="vv-logo" src="assets/${esc(bundle.meta.logo)}" alt="">` : ''
  const version = bundle.meta?.version ? `<span class="vv-version">${esc(bundle.meta.version)}</span>` : ''
  const toc = o.toc.length
    ? `<aside class="vv-toc" aria-label="Nesta página"><p>Nesta página</p><ul>${o.toc.map(([l, a, t]) => `<li class="vv-l${l}"><a href="#${esc(a)}">${esc(t)}</a></li>`).join('')}</ul></aside>`
    : '<aside class="vv-toc"></aside>'
  const date = new Date(bundle.generatedAt)
  const when = Number.isNaN(date.getTime()) ? bundle.generatedAt : date.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
  return [
    '<!doctype html>',
    '<html lang="pt-BR"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="VVPost">',
    `<title>${esc(o.pageTitle === o.title ? o.title : `${o.pageTitle} · ${o.title}`)}</title>`,
    o.baseUrl ? `<link rel="canonical" href="${esc(`${o.baseUrl}/${o.current}`)}">` : '',
    '<link rel="stylesheet" href="assets/vvpost-site.css">',
    '<script src="assets/vvpost-search.js" defer></script>',
    // Antes do script do site: os dois são defer e rodam na ordem, e o do site desenha os diagramas.
    o.mermaid ? `<script src="${MERMAID_FILE}" defer></script>` : '',
    '<script src="assets/vvpost-site.js" defer></script>',
    '</head><body>',
    '<a class="vv-skip" href="#vv-titulo">Ir para o conteúdo</a>',
    `<header class="vv-top"><button class="vv-menu" type="button" aria-label="Navegação" aria-expanded="false">☰</button><a class="vv-brand" href="index.html">${logo}<span>${esc(o.title)}</span></a>${version}`,
    '<div class="vv-search" role="search"><input type="search" placeholder="Buscar na documentação" aria-label="Buscar na documentação" autocomplete="off"><ul class="vv-results" hidden></ul></div>',
    o.changelog ? `<a class="vv-changes${o.current === CHANGELOG_FILE ? ' vv-current' : ''}" href="${CHANGELOG_FILE}">Mudanças</a>` : '',
    '</header>',
    `<div class="vv-layout"><nav class="vv-nav" aria-label="Documentação">${o.nav}</nav>`,
    `<main class="vv-main">${o.main}</main>${toc}</div>`,
    `<footer class="vv-footer">${bundle.meta?.organization ? `${esc(bundle.meta.organization)} · ` : ''}Gerado pelo VVPost em ${esc(when)}</footer>`,
    '</body></html>',
    ''
  ].join('')
}

function renderNav(nodes: PublishTreeNode[], files: Map<string, string>, current: string): string {
  const list = (items: PublishTreeNode[]): string => {
    if (!items.length) return ''
    return `<ul>${items
      .map((n) => {
        const file = files.get(n.key)
        if (!file) return `<li class="vv-folder"><details open><summary>${esc(n.title)}</summary>${list(n.children)}</details></li>`
        const here = file === current
        return `<li><a href="${file}"${here ? ' class="vv-current" aria-current="page"' : ''}>${esc(n.title)}</a>${list(n.children)}</li>`
      })
      .join('')}</ul>`
  }
  return list(nodes)
}

function childLink(n: PublishTreeNode, files: Map<string, string>): string {
  const file = files.get(n.key)
  const inner = n.children.length ? `<ul>${n.children.map((c) => childLink(c, files)).join('')}</ul>` : ''
  return `<li>${file ? `<a href="${file}">${esc(n.title)}</a>` : esc(n.title)}${inner}</li>`
}

function renderChangelog(entries: ChangelogEntry[], files: Map<string, string>): string {
  // Um endpoint aponta para a página dele ou, quando ele é uma seção, para a do conector.
  const endpointFile = (key: string) => files.get(`endpoint:${key}`) ?? files.get(`connector:${key.slice(0, key.lastIndexOf('/'))}`)
  const ref = (r: ChangelogRef, link: 'page' | 'endpoint' | null) => {
    const file = link === 'page' ? files.get(r.key) : link === 'endpoint' ? endpointFile(r.key) : undefined
    return `<li>${file ? `<a href="${file}">${esc(r.title)}</a>` : esc(r.title)}</li>`
  }
  const group = (label: string, list: ChangelogRef[], link: 'page' | 'endpoint' | null, kind: string) =>
    list.length ? `<h3 class="vv-${kind}">${label}</h3><ul>${list.map((r) => ref(r, link)).join('')}</ul>` : ''
  const body = entries.map((e) => {
    const date = new Date(e.at)
    const when = Number.isNaN(date.getTime()) ? e.at : date.toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
    const head = `<h2 id="${esc(slugify(e.label ?? e.at) || 'versao')}">${e.label ? `${esc(e.label)} <small>${esc(when)}</small>` : esc(when)}</h2>`
    if (e.initial) return `${head}<p>Primeira publicação da documentação.</p>`
    const parts = [
      group('Endpoints novos', e.endpoints.added, 'endpoint', 'added'),
      group('Endpoints alterados', e.endpoints.changed, 'endpoint', 'changed'),
      group('Endpoints removidos', e.endpoints.removed, null, 'removed'),
      group('Páginas novas', e.pages.added, 'page', 'added'),
      group('Páginas alteradas', e.pages.changed, 'page', 'changed'),
      group('Páginas removidas', e.pages.removed, null, 'removed')
    ].join('')
    return `${head}${parts || '<p>Sem mudanças no conteúdo.</p>'}`
  })
  return `<h1 id="vv-titulo">Mudanças</h1><div class="vv-changelog">${body.join('') || '<p>Nenhuma exportação registrada.</p>'}</div>`
}

/** Títulos de nível 2 a 4 da página, para o "Nesta página" e a busca. */
function collectHeadings(blocks: PublishBlock[]): [number, string, string][] {
  const out: [number, string, string][] = []
  for (const b of blocks) if (b.type === 'heading' && b.level >= 2 && b.level <= 4) out.push([b.level, b.anchor, plain(b.children)])
  return out
}

function collectAssets(blocks: PublishBlock[], used: Set<string>): void {
  const inline = (list: PublishInline[]) => {
    for (const n of list) {
      if (n.type === 'image' && n.asset) used.add(n.asset)
      else if ('children' in n) inline(n.children)
    }
  }
  for (const b of blocks) {
    if (b.type === 'diagram' && b.asset) used.add(b.asset)
    else if (b.type === 'heading' || b.type === 'paragraph') inline(b.children)
    else if (b.type === 'table') [...b.header, ...b.rows.flat()].forEach(inline)
    else if (b.type === 'list') b.items.forEach((i) => collectAssets(i.blocks, used))
    else if (b.type === 'alert' || b.type === 'quote') collectAssets(b.blocks, used)
  }
}

/** Texto puro da página para a busca. */
function blocksText(blocks: PublishBlock[]): string {
  const parts: string[] = []
  const walk = (list: PublishBlock[]) => {
    for (const b of list) {
      if (b.type === 'heading' || b.type === 'paragraph') parts.push(plain(b.children))
      else if (b.type === 'table') parts.push([...b.header, ...b.rows.flat()].map(plain).join(' '))
      else if (b.type === 'list') b.items.forEach((i) => walk(i.blocks))
      else if (b.type === 'alert' || b.type === 'quote') walk(b.blocks)
      else if (b.type === 'code') parts.push(b.text)
    }
  }
  walk(blocks)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** Só endereços que não rodam nada: http(s), mailto, tel e relativos. */
function safeHref(href: string): string | null {
  const h = href.trim()
  if (/^(https?:|mailto:|tel:)/i.test(h)) return h
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null
  return h
}

function renderInline(list: PublishInline[], r: RenderCtx): string {
  return list
    .map((n) => {
      switch (n.type) {
        case 'text':
          return esc(n.text)
        case 'strong':
        case 'em':
        case 'del':
          return `<${n.type}>${renderInline(n.children, r)}</${n.type}>`
        case 'code':
          return `<code>${esc(n.text)}</code>`
        case 'break':
          return '<br>'
        case 'link': {
          const href = safeHref(n.href)
          const inner = renderInline(n.children, r)
          if (href === null) return inner
          const external = /^https?:/i.test(href)
          return `<a href="${esc(href)}"${external ? ' rel="noopener"' : ''}>${inner}</a>`
        }
        case 'pageLink': {
          const file = r.files.get(n.page)
          const inner = renderInline(n.children, r)
          return file ? `<a href="${file}${n.anchor ? `#${esc(n.anchor)}` : ''}">${inner}</a>` : inner
        }
        case 'anchorLink':
          return `<a href="#${esc(n.anchor)}">${renderInline(n.children, r)}</a>`
        case 'image': {
          if (n.asset) return r.assets.has(n.asset) ? `<img src="assets/${esc(n.asset)}" alt="${esc(n.alt)}" loading="lazy">` : esc(n.alt)
          return n.url && /^https?:/i.test(n.url) ? `<img src="${esc(n.url)}" alt="${esc(n.alt)}" loading="lazy">` : esc(n.alt)
        }
      }
    })
    .join('')
}

function renderBlocks(blocks: PublishBlock[], r: RenderCtx): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'heading': {
          const level = Math.min(6, Math.max(2, b.level))
          return `<h${level} id="${esc(b.anchor)}">${renderInline(b.children, r)}<a class="vv-anchor" href="#${esc(b.anchor)}" aria-label="Link para esta seção">#</a></h${level}>`
        }
        case 'paragraph':
          return `<p>${renderInline(b.children, r)}</p>`
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul'
          const start = b.ordered && b.start !== undefined ? ` start="${b.start}"` : ''
          const items = b.items
            .map((i) => {
              const box = i.checked === undefined ? '' : `<input type="checkbox" disabled${i.checked ? ' checked' : ''}> `
              // Item "tight" com um parágrafo só: sem o <p> em volta.
              const only = i.blocks.length === 1 && i.blocks[0]!.type === 'paragraph' ? renderInline((i.blocks[0] as { children: PublishInline[] }).children, r) : renderBlocks(i.blocks, r)
              return `<li${i.checked === undefined ? '' : ' class="vv-task"'}>${box}${only}</li>`
            })
            .join('')
          return `<${tag}${start}>${items}</${tag}>`
        }
        case 'table': {
          const align = (i: number) => (b.align[i] ? ` style="text-align:${b.align[i]}"` : '')
          const head = `<tr>${b.header.map((c, i) => `<th${align(i)}>${renderInline(c, r)}</th>`).join('')}</tr>`
          const rows = b.rows.map((row) => `<tr>${row.map((c, i) => `<td${align(i)}>${renderInline(c, r)}</td>`).join('')}</tr>`).join('')
          return `<div class="vv-table"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>`
        }
        case 'code':
          return `<pre class="vv-code"><code${b.language ? ` class="language-${esc(b.language)}"` : ''}>${esc(b.text)}</code></pre>`
        case 'diagram': {
          const code = `<pre class="vv-code"><code class="language-mermaid">${esc(b.source)}</code></pre>`
          if (b.asset && r.assets.has(b.asset)) {
            return `<figure class="vv-diagram"><img src="assets/${esc(b.asset)}" alt="Diagrama" loading="lazy"><details><summary>Código do diagrama</summary>${code}</details></figure>`
          }
          if (r.live) {
            // O texto fica no <pre> até o Mermaid desenhar; se ele falhar, o código continua legível.
            return `<figure class="vv-diagram vv-diagram-live"><pre class="vv-mermaid" role="img" aria-label="Diagrama">${esc(b.source)}</pre><details><summary>Código do diagrama</summary>${code}</details></figure>`
          }
          return `<figure class="vv-diagram vv-diagram-code"><figcaption>Diagrama (código Mermaid)</figcaption>${code}</figure>`
        }
        case 'alert':
          return `<div class="vv-alert vv-alert-${b.kind}"><p class="vv-alert-title">${ALERT_TITLE[b.kind]}</p>${renderBlocks(b.blocks, r)}</div>`
        case 'quote':
          return `<blockquote>${renderBlocks(b.blocks, r)}</blockquote>`
        case 'rule':
          return '<hr>'
        case 'html':
          // HTML cru do Markdown aparece como texto: o site nunca interpreta o que veio dos arquivos.
          return `<pre class="vv-raw">${esc(b.text)}</pre>`
      }
    })
    .join('\n')
}

function siteCss(primary: string | undefined): string {
  const accent = primary && /^#[0-9A-Fa-f]{6}$/.test(primary) ? primary : '#5b5bd6'
  return `:root{--vv-accent:${accent}}\n${SITE_CSS}`
}

/** Texto de uma página do site para o diff do plano: o <main>, sem as tags, uma linha por bloco. */
export function htmlPageText(html: string): string {
  const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html
  return main
    .replace(/<a class="vv-anchor"[^>]*>#<\/a>/g, '')
    .replace(/<nav class="vv-pager"[\s\S]*?<\/nav>/g, '')
    .replace(/<(\/?(p|h[1-6]|li|tr|pre|div|figure|blockquote|hr|br|ul|ol|table|details|summary))\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
}
