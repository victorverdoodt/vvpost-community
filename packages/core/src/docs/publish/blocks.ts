import { Lexer, type Token, type Tokens } from 'marked'
import { slugBase } from '../markdown'
import type { AlertKind, PublishBlock, PublishInline, PublishListItem } from './types'

/** O que um link ou imagem do Markdown vira no pacote. */
export interface BlockResolvers {
  /** Link relativo: outra página do pacote, uma âncora desta página ou um link comum. */
  link(href: string): { page: string; anchor?: string } | { anchor: string } | { href: string }
  /** Imagem: um anexo do pacote, uma URL externa ou nada (a imagem vira o texto alternativo). */
  image(src: string): { asset: string } | { url: string } | null
  /** Diagrama Mermaid: o id do anexo que terá a imagem. */
  diagram(source: string): string
}

const ANCHOR = /\s*\{#([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\s*$/
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i
const ORIGIN = /^%% vvpost:origem .*$/gm

/**
 * Markdown (GFM) da documentação para a árvore neutra do pacote. Títulos ganham a âncora do
 * `{#id}` ou a do GitHub (as repetidas com -1, -2...), alertas `> [!NOTE]` viram alert, blocos
 * mermaid viram diagram e HTML cru fica como texto.
 */
export function markdownToBlocks(markdown: string, resolvers: BlockResolvers): PublishBlock[] {
  const tokens = new Lexer({ gfm: true }).lex(markdown)
  const seen = new Map<string, number>()
  const anchorFor = (text: string, explicit?: string) => {
    if (explicit) return explicit
    const base = slugBase(text)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }

  const inline = (tokens: Token[] | undefined): PublishInline[] => {
    const out: PublishInline[] = []
    for (const t of tokens ?? []) {
      switch (t.type) {
        case 'text':
        case 'escape': {
          const tk = t as Tokens.Text
          if (tk.tokens?.length) out.push(...inline(tk.tokens))
          else pushText(out, tk.text)
          break
        }
        case 'strong':
        case 'em':
        case 'del':
          out.push({ type: t.type, children: inline((t as Tokens.Strong).tokens) })
          break
        case 'codespan':
          out.push({ type: 'code', text: (t as Tokens.Codespan).text })
          break
        case 'br':
          out.push({ type: 'break' })
          break
        case 'link': {
          const tk = t as Tokens.Link
          const children = inline(tk.tokens)
          const target = resolvers.link(tk.href)
          if ('page' in target) out.push({ type: 'pageLink', page: target.page, ...(target.anchor && { anchor: target.anchor }), children })
          else if ('anchor' in target) out.push({ type: 'anchorLink', anchor: target.anchor, children })
          else out.push({ type: 'link', href: target.href, children })
          break
        }
        case 'image': {
          const tk = t as Tokens.Image
          const target = resolvers.image(tk.href)
          if (target) out.push({ type: 'image', alt: tk.text, ...target })
          else pushText(out, tk.text)
          break
        }
        case 'html':
          pushText(out, (t as Tokens.HTML).text)
          break
        default:
          if ('text' in t && typeof t.text === 'string') pushText(out, t.text)
      }
    }
    return out
  }

  const blocks = (tokens: Token[]): PublishBlock[] => {
    const out: PublishBlock[] = []
    for (const t of tokens) {
      switch (t.type) {
        case 'space':
        case 'def':
          break
        case 'heading': {
          const tk = t as Tokens.Heading
          const m = ANCHOR.exec(tk.text)
          const children = inline(m ? new Lexer({ gfm: true }).inlineTokens(tk.text.replace(ANCHOR, '')) : tk.tokens)
          out.push({ type: 'heading', level: tk.depth as 1, anchor: anchorFor(plain(children), m?.[1]), children })
          break
        }
        case 'paragraph':
          out.push({ type: 'paragraph', children: inline((t as Tokens.Paragraph).tokens) })
          break
        case 'text': {
          // Texto solto (item de lista "tight"): vira parágrafo.
          const tk = t as Tokens.Text
          out.push({ type: 'paragraph', children: tk.tokens?.length ? inline(tk.tokens) : [{ type: 'text', text: tk.text }] })
          break
        }
        case 'code': {
          const tk = t as Tokens.Code
          const lang = tk.lang?.trim().split(/\s+/)[0]?.toLowerCase()
          if (lang === 'mermaid') {
            const source = tk.text.replace(ORIGIN, '').trim()
            out.push({ type: 'diagram', asset: resolvers.diagram(source), source })
          } else out.push({ type: 'code', ...(lang && { language: lang }), text: tk.text })
          break
        }
        case 'blockquote': {
          const tk = t as Tokens.Blockquote
          const first = tk.tokens[0]
          const m = first?.type === 'paragraph' ? ALERT.exec((first as Tokens.Paragraph).text) : null
          if (m) {
            const rest = (first as Tokens.Paragraph).text.replace(ALERT, '')
            const body = [...(rest.trim() ? new Lexer({ gfm: true }).lex(rest) : []), ...tk.tokens.slice(1)]
            out.push({ type: 'alert', kind: m[1]!.toLowerCase() as AlertKind, blocks: blocks(body) })
          } else out.push({ type: 'quote', blocks: blocks(tk.tokens) })
          break
        }
        case 'list': {
          const tk = t as Tokens.List
          const items: PublishListItem[] = tk.items.map((item) => ({
            ...(item.task && { checked: item.checked === true }),
            blocks: blocks(item.tokens.filter((x) => x.type !== 'checkbox'))
          }))
          out.push({ type: 'list', ordered: tk.ordered, ...(tk.ordered && typeof tk.start === 'number' && tk.start !== 1 && { start: tk.start }), items })
          break
        }
        case 'table': {
          const tk = t as Tokens.Table
          out.push({
            type: 'table',
            align: tk.align,
            header: tk.header.map((c) => inline(c.tokens)),
            rows: tk.rows.map((r) => r.map((c) => inline(c.tokens)))
          })
          break
        }
        case 'hr':
          out.push({ type: 'rule' })
          break
        case 'html': {
          const text = (t as Tokens.HTML).text.trim()
          // Comentários HTML não aparecem em nenhum renderizador de Markdown.
          if (text && !/^<!--[\s\S]*-->$/.test(text)) out.push({ type: 'html', text })
          break
        }
        default:
          if ('raw' in t && typeof t.raw === 'string' && t.raw.trim()) out.push({ type: 'paragraph', children: [{ type: 'text', text: t.raw.trim() }] })
      }
    }
    return out
  }

  return blocks(tokens)
}

function pushText(out: PublishInline[], text: string) {
  const decoded = decodeEntities(text)
  const last = out[out.length - 1]
  if (last?.type === 'text') last.text += decoded
  else if (decoded) out.push({ type: 'text', text: decoded })
}

// O lexer devolve o texto com as entidades do Markdown (&amp;, &lt;...) já escapadas.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }
function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e: string) => ENTITIES[e]!)
}

/** Texto puro de uma sequência inline (âncoras, títulos de link, diff). */
export function plain(nodes: PublishInline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
        case 'code':
          return n.text
        case 'image':
          return n.alt
        case 'break':
          return ' '
        default:
          return plain(n.children)
      }
    })
    .join('')
}

/** Texto puro da página, uma linha por bloco, para o diff do plano. */
export function blocksToText(blocks: PublishBlock[]): string {
  const lines: string[] = []
  const walk = (list: PublishBlock[], indent: string) => {
    for (const b of list) {
      switch (b.type) {
        case 'heading':
          lines.push(`${indent}${'#'.repeat(b.level)} ${plain(b.children)}`)
          break
        case 'paragraph':
          lines.push(`${indent}${plain(b.children)}`)
          break
        case 'list':
          b.items.forEach((item, i) => {
            const mark = b.ordered ? `${(b.start ?? 1) + i}.` : '-'
            const start = lines.length
            walk(item.blocks, `${indent}  `)
            if (lines.length > start) lines[start] = `${indent}${mark} ${lines[start]!.trimStart()}`
          })
          break
        case 'table':
          lines.push(`${indent}| ${b.header.map(plain).join(' | ')} |`)
          for (const r of b.rows) lines.push(`${indent}| ${r.map(plain).join(' | ')} |`)
          break
        case 'code':
        case 'html':
          lines.push(...b.text.split('\n').map((l) => indent + l))
          break
        case 'diagram':
          lines.push(`${indent}[diagrama]`, ...b.source.split('\n').map((l) => indent + l))
          break
        case 'alert':
        case 'quote':
          walk(b.blocks, `${indent}> `)
          break
        case 'rule':
          lines.push(`${indent}---`)
      }
    }
  }
  walk(blocks, '')
  return lines.join('\n')
}
