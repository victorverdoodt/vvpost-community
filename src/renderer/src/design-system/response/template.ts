// Template do modo Visualize: um subconjunto do Handlebars, o motor que o pm.visualizer do Postman
// usa. {{caminho}} escapa HTML, {{{caminho}}} não escapa; blocos {{#each}}, {{#if}}, {{#unless}},
// {{#with}} com {{else}}; dentro de blocos, this, @index, @key, @first, @last e ../ (escopo acima).
// Puro e sem eval: o HTML resultante roda isolado no iframe do Visualize.

type Node =
  | { type: 'text'; text: string }
  | { type: 'var'; path: string; raw: boolean }
  | { type: 'block'; name: string; path: string; body: Node[]; inverse: Node[] }

interface Scope {
  value: unknown
  vars: Record<string, unknown>
  parent: Scope | null
}

export class TemplateError extends Error {}

export function renderTemplate(template: string, data: unknown): string {
  return render(parseTemplate(template), { value: data, vars: { root: data }, parent: null })
}

export function parseTemplate(template: string): Node[] {
  const re = /\{\{\{\s*([^}]*?)\s*\}\}\}|\{\{(~?)\s*([#/^]?)\s*([^}]*?)\s*(~?)\}\}/g
  const root: Node[] = []
  const stack: { node: Extract<Node, { type: 'block' }>; inElse: boolean }[] = []
  const target = () => {
    const top = stack.at(-1)
    return top ? (top.inElse ? top.node.inverse : top.node.body) : root
  }
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(template))) {
    if (m.index > last) target().push({ type: 'text', text: template.slice(last, m.index) })
    last = re.lastIndex
    if (m[1] !== undefined) {
      target().push({ type: 'var', path: m[1], raw: true })
      continue
    }
    const sigil = m[3]
    const content = m[4]!
    if (content.startsWith('!')) continue
    if (sigil === '#') {
      const [name = '', ...rest] = content.split(/\s+/)
      if (!['each', 'if', 'unless', 'with'].includes(name)) throw new TemplateError(`Bloco desconhecido: #${name}`)
      const node: Extract<Node, { type: 'block' }> = { type: 'block', name, path: rest.join(' ') || 'this', body: [], inverse: [] }
      target().push(node)
      stack.push({ node, inElse: false })
    } else if (sigil === '/') {
      const top = stack.pop()
      if (!top || top.node.name !== content.trim()) throw new TemplateError(`{{/${content}}} sem o bloco de abertura`)
    } else if (content === 'else' || sigil === '^') {
      const top = stack.at(-1)
      if (!top) throw new TemplateError('{{else}} fora de um bloco')
      top.inElse = true
    } else {
      target().push({ type: 'var', path: content, raw: false })
    }
  }
  if (stack.length) throw new TemplateError(`Falta {{/${stack.at(-1)!.node.name}}}`)
  if (last < template.length) root.push({ type: 'text', text: template.slice(last) })
  return root
}

function render(nodes: Node[], scope: Scope): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') out += n.text
    else if (n.type === 'var') {
      const v = lookup(n.path, scope)
      const text = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      out += n.raw ? text : escapeHtml(text)
    } else {
      const v = lookup(n.path, scope)
      if (n.name === 'each') {
        const items: [string | number, unknown][] = Array.isArray(v)
          ? v.map((x, i) => [i, x])
          : v && typeof v === 'object'
            ? Object.entries(v)
            : []
        if (!items.length) out += render(n.inverse, scope)
        items.forEach(([key, item], i) => {
          out += render(n.body, {
            value: item,
            vars: { index: i, key, first: i === 0, last: i === items.length - 1 },
            parent: scope
          })
        })
      } else if (n.name === 'with') {
        out += truthy(v) ? render(n.body, { value: v, vars: {}, parent: scope }) : render(n.inverse, scope)
      } else {
        const ok = n.name === 'if' ? truthy(v) : !truthy(v)
        out += render(ok ? n.body : n.inverse, scope)
      }
    }
  }
  return out
}

function truthy(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : !!v
}

function lookup(path: string, scope: Scope): unknown {
  let s: Scope = scope
  let p = path.trim()
  while (p.startsWith('../')) {
    s = s.parent ?? s
    p = p.slice(3)
  }
  if (p.startsWith('@')) {
    const [name = '', ...rest] = p.slice(1).split('.')
    for (let cur: Scope | null = s; cur; cur = cur.parent) {
      if (name in cur.vars) return dig(cur.vars[name], rest)
    }
    return undefined
  }
  if (p === 'this' || p === '.') return s.value
  const parts = p.replace(/^this\./, '').split('.')
  const own = dig(s.value, parts)
  if (own !== undefined || p.startsWith('this.')) return own
  // Como no Handlebars com compat: procura nos escopos de fora.
  for (let cur = s.parent; cur; cur = cur.parent) {
    const found = dig(cur.value, parts)
    if (found !== undefined) return found
  }
  return undefined
}

function dig(value: unknown, parts: string[]): unknown {
  let v = value
  for (const part of parts) {
    if (v === null || typeof v !== 'object') return undefined
    v = (v as Record<string, unknown>)[part.replace(/^\[|\]$/g, '')]
  }
  return v
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`=]/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** Template de exemplo: tabela com os itens da resposta (array na raiz ou no primeiro campo). */
export const EXAMPLE_TEMPLATE = `<style>
  body { font: 13px system-ui, sans-serif; color: #e7eaf0; background: #0b0c0f; margin: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #282e3a; padding: 4px 8px; text-align: left; }
  th { color: #929bad; font-weight: 500; }
</style>
<!-- {{caminho}} lê da resposta em JSON; vv.response (e pm.response) ficam disponíveis nos scripts. -->
<p id="status"></p>
<table>
  {{#each this}}
    <tr><th>{{@key}}</th><td>{{this}}</td></tr>
  {{/each}}
</table>
<script>
  // Sem rede e sem acesso ao app: só a resposta.
  document.getElementById('status').textContent = 'Status ' + vv.response.status
</script>
`
