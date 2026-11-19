import type { DocsBand, DocsConfig } from '@vvpost/schemas'

/** O que preenche os {{...}} do cabeçalho, do rodapé e da capa. */
export interface PrintContext {
  title: string
  project: string
  /** Data do documento, já formatada. */
  date: string
  /** Logo do modelo como data: URL (readDocsLogo). */
  logo?: string
}

export interface PrintLayout {
  /** CSS da página de impressão. */
  css: string
  /** Capa (HTML) antes do conteúdo; vazia sem capa. */
  cover: string
  /** Linha %%{init}%% que põe os diagramas Mermaid nas cores do modelo. */
  mermaidInit: string
  headerTemplate: string
  footerTemplate: string
  /** Opções do printToPDF do Chromium. */
  pdf: {
    pageSize: 'A4' | 'Letter' | 'Legal'
    landscape: boolean
    margins: { top: number; bottom: number; left: number; right: number }
  }
}

const FONTS = {
  sans: 'Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif',
  serif: '"Source Serif 4", "Source Serif Pro", Georgia, Cambria, "Times New Roman", serif',
  mono: '"JetBrains Mono", "Cascadia Mono", Consolas, "SFMono-Regular", Menlo, monospace'
} as const

/** Margens laterais em polegadas; cabeçalho e rodapé somam a altura da faixa. */
const MARGINS = { narrow: 0.4, normal: 0.55, wide: 0.9 } as const
const BAND_INCHES = 0.35

/** Rodapé de quando o modelo não diz outro: o título e a página, como sempre foi. */
const DEFAULT_FOOTER: DocsBand = { left: '{{title}}', right: '{{page}} / {{pages}}' }

const COLOR = /^#[0-9A-Fa-f]{6}$/
/** Cor do modelo só se for #RRGGBB (o schema garante; aqui é a segunda trava, o valor vai para CSS). */
const color = (value: string | undefined, fallback: string) => (value && COLOR.test(value) ? value : fallback)

export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Troca os {{...}} de um texto do modelo, já escapado; page e pages viram os campos do Chromium. */
export function fillPlaceholders(text: string, config: DocsConfig, ctx: PrintContext, html = true): string {
  const values: Record<string, string> = {
    title: ctx.title,
    subtitle: config.subtitle ?? '',
    project: ctx.project,
    version: config.version ?? '',
    organization: config.organization ?? '',
    date: ctx.date
  }
  const escaped = html ? escapeHtml(text) : text
  return escaped.replace(/\{\{\s*([a-z]+)\s*\}\}/g, (all, key: string) => {
    if (key === 'page') return html ? '<span class="pageNumber"></span>' : '1'
    if (key === 'pages') return html ? '<span class="totalPages"></span>' : '1'
    const value = values[key]
    return value === undefined ? all : html ? escapeHtml(value) : value
  })
}

function bandTemplate(band: DocsBand | undefined, config: DocsConfig, ctx: PrintContext, side: number): string {
  if (!band || !(band.left || band.center || band.right || (band.logo && band.logo !== 'none' && ctx.logo))) return '<span></span>'
  const logo = ctx.logo && band.logo && band.logo !== 'none' ? `<img src="${escapeHtml(ctx.logo)}" style="height:16pt;max-width:120pt;object-fit:contain" alt="">` : ''
  const cell = (text: string | undefined, align: string, withLogo: boolean) =>
    `<div style="flex:1;display:flex;align-items:center;gap:6pt;justify-content:${align};min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">` +
    `${withLogo && align === 'flex-start' ? logo : ''}${text ? `<span>${fillPlaceholders(text, config, ctx)}</span>` : ''}${withLogo && align === 'flex-end' ? logo : ''}</div>`
  return (
    `<div style="width:100%;font-family:${escapeHtml(FONTS[config.theme?.font ?? 'sans'])};font-size:7.5pt;color:#7d8498;padding:0 ${side}in;display:flex;align-items:center;gap:8pt;-webkit-print-color-adjust:exact">` +
    cell(band.left, 'flex-start', band.logo === 'left') +
    cell(band.center, 'center', false) +
    cell(band.right, 'flex-end', band.logo === 'right') +
    '</div>'
  )
}

/**
 * Página de impressão pelo modelo do projeto: cores, fontes, tamanho e margens da página,
 * capa, cabeçalho e rodapé. Sem modelo, o resultado é o PDF de sempre (tema claro, título e
 * página no rodapé). Tudo que vem do modelo entra escapado; as cores só como #RRGGBB.
 */
/** Altura da página em polegadas (retrato), para o diagrama alto caber numa página só. */
const PAGE_HEIGHT: Record<string, [number, number]> = { A4: [11.69, 8.27], Letter: [11, 8.5], Legal: [14, 8.5] }

function diagramMaxHeight(config: DocsConfig, margins: { top: number; bottom: number }): number {
  const [tall, wide] = PAGE_HEIGHT[config.page?.size ?? 'A4'] ?? PAGE_HEIGHT['A4']!
  const height = config.page?.orientation === 'landscape' ? wide : tall
  return Math.max(3, Math.round((height - margins.top - margins.bottom - 0.6) * 100) / 100)
}

/** Mistura a cor com o branco (0: a cor, 1: branco), para os fundos dos diagramas. */
function tint(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(c + (255 - c) * amount)
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, '0')).join('')}`
}

/** Diagramas Mermaid nas cores do modelo (tema base), em vez do amarelo e lilás padrão. */
function mermaidInit(primary: string, text: string): string {
  const vars = {
    primaryColor: tint(primary, 0.88),
    primaryBorderColor: primary,
    primaryTextColor: text,
    secondaryColor: tint(primary, 0.94),
    tertiaryColor: '#f7f8fb',
    clusterBkg: tint(primary, 0.96),
    clusterBorder: tint(primary, 0.55),
    lineColor: '#5b6276',
    textColor: text,
    noteBkgColor: '#fff8e6',
    noteBorderColor: '#e0c27a',
    actorBkg: tint(primary, 0.88),
    actorBorder: primary,
    signalColor: '#3d4560'
  }
  return `%%{init: ${JSON.stringify({ theme: 'base', themeVariables: vars })}}%%`
}

export function printLayout(config: DocsConfig, ctx: PrintContext, options: { cover?: boolean } = {}): PrintLayout {
  const t = config.theme ?? {}
  const primary = color(t.primary, '#8b7cff')
  const heading = color(t.heading, '#11141a')
  const text = color(t.text, '#1d2230')
  const body = FONTS[t.font ?? 'sans']
  const headings = FONTS[t.headingFont ?? t.font ?? 'sans']
  const side = MARGINS[config.page?.margins ?? 'normal']
  const header = config.header
  const footer = config.footer ?? DEFAULT_FOOTER
  const hasHeader = bandTemplate(header, config, ctx, side) !== '<span></span>'
  const hasFooter = bandTemplate(footer, config, ctx, side) !== '<span></span>'
  const margins = { top: hasHeader ? side + BAND_INCHES : side, bottom: hasFooter ? side + 0.1 : side, left: side, right: side }

  const css = `
@page { size: ${config.page?.size ?? 'A4'} ${config.page?.orientation ?? 'portrait'}; margin: ${margins.top}in ${margins.right}in ${margins.bottom}in ${margins.left}in; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: ${text}; background: #fff; font: 10.5pt/1.5 ${body}; }
main { padding: 0 2px; }
h1, h2, h3, h4, h5, h6 { font-family: ${headings}; color: ${heading}; break-after: avoid; }
h1 { font-size: 20pt; margin: 0 0 6pt; border-bottom: 3px solid ${primary}; padding-bottom: 6pt; }
h2 { font-size: 15pt; margin: 22pt 0 8pt; border-bottom: 1px solid #d8dbe4; padding-bottom: 3pt; }
h3 { font-size: 12.5pt; margin: 16pt 0 6pt; }
h4 { font-size: 11pt; margin: 12pt 0 4pt; opacity: 0.85; }
h5, h6 { font-size: 10.5pt; margin: 10pt 0 4pt; opacity: 0.85; }
p, ul, ol { margin: 4pt 0 8pt; }
img { max-width: 100%; }
blockquote { margin: 6pt 0 10pt; padding: 6pt 10pt; border-left: 3px solid ${primary}; background: ${primary}12; color: #3d4560; }
blockquote p { margin: 2pt 0; }
a { color: #1f6fb2; text-decoration: none; }
code, pre { font-family: ${FONTS.mono}; font-size: 8.8pt; }
code { background: #f1f3f7; border-radius: 3px; padding: 0 3px; }
pre { background: #f6f7fa; border: 1px solid #e1e4ec; border-radius: 4px; padding: 6pt 8pt; white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 4pt 0 10pt; font-size: 9pt; break-inside: auto; }
tr { break-inside: avoid; }
th, td { border: 1px solid #e1e4ec; padding: 3pt 6pt; text-align: left; vertical-align: top; word-break: break-word; }
th { background: #f1f3f7; font-weight: 600; }
details > summary { font-weight: 600; margin: 4pt 0; }
figure.mermaid-diagram { margin: 6pt 0 12pt; text-align: center; break-inside: avoid; }
figure.mermaid-diagram svg { max-width: 100%; height: auto; max-height: ${diagramMaxHeight(config, margins)}in; }
figure.mermaid-diagram.mermaid-tall { break-inside: auto; }
figure.mermaid-diagram figcaption { font-size: 9pt; color: #5b6276; margin-bottom: 4pt; text-align: left; break-after: avoid; }
figure.mermaid-diagram.mermaid-tall svg { max-height: none; }
.mermaid-error { color: #b42318; font-size: 9pt; }
.doc-cover { display: flex; flex-direction: column; gap: 10pt; break-after: page; border-left: 8pt solid ${primary}; margin-top: 1.8in; padding: 24pt 0 24pt 28pt; }
.doc-cover img { max-height: 1.1in; max-width: 3in; object-fit: contain; align-self: flex-start; margin-bottom: 18pt; }
.doc-cover .doc-cover-title { font-family: ${headings}; font-size: 30pt; line-height: 1.15; font-weight: 700; color: ${heading}; }
.doc-cover .doc-cover-subtitle { font-size: 14pt; color: #3d4560; }
.doc-cover .doc-cover-meta { margin-top: 24pt; font-size: 10pt; color: #5b6276; }
`

  let cover = ''
  if (options.cover) {
    const meta = [config.organization, config.version && `Versão ${config.version}`, ctx.date].filter(Boolean) as string[]
    cover = [
      '<section class="doc-cover">',
      ctx.logo ? `<img src="${escapeHtml(ctx.logo)}" alt="Logo">` : '',
      `<div class="doc-cover-title">${escapeHtml(ctx.title)}</div>`,
      config.subtitle ? `<div class="doc-cover-subtitle">${escapeHtml(config.subtitle)}</div>` : '',
      `<div class="doc-cover-meta">${meta.map(escapeHtml).join(' · ')}</div>`,
      '</section>'
    ].join('')
  }

  return {
    css,
    cover,
    mermaidInit: mermaidInit(primary, text),
    headerTemplate: bandTemplate(header, config, ctx, side),
    footerTemplate: bandTemplate(footer, config, ctx, side),
    pdf: {
      pageSize: config.page?.size ?? 'A4',
      landscape: config.page?.orientation === 'landscape',
      margins
    }
  }
}
