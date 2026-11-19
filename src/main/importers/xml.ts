/**
 * Leitor de XML mínimo para o importador de WSDL: elementos, atributos, texto e namespaces, sem
 * DTD nem entidades externas (que nunca são buscadas). Não valida; um documento malformado dá erro
 * com a linha.
 */

export interface XmlElement {
  /** Nome como está no arquivo, com o prefixo. */
  name: string
  local: string
  /** URI do namespace do elemento, resolvido pelos `xmlns` em escopo. */
  ns: string
  attrs: Record<string, string>
  children: XmlElement[]
  text: string
  /** Prefixos em escopo neste elemento, para resolver QNames em atributos (`type="tns:Pedido"`). */
  scope: Record<string, string>
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e] ?? m
  })
}

export function parseXml(source: string): XmlElement {
  let i = 0
  const n = source.length
  const line = () => source.slice(0, i).split('\n').length
  const fail = (msg: string): never => {
    throw new Error(`XML inválido na linha ${line()}: ${msg}`)
  }
  const stack: XmlElement[] = []
  let root: XmlElement | undefined
  const XML_NS = 'http://www.w3.org/XML/1998/namespace'
  while (i < n) {
    const lt = source.indexOf('<', i)
    if (lt === -1) {
      if (source.slice(i).trim() && !stack.length) fail('texto fora do elemento raiz')
      stack.at(-1) && (stack.at(-1)!.text += decodeEntities(source.slice(i)))
      break
    }
    if (lt > i && stack.length) stack.at(-1)!.text += decodeEntities(source.slice(i, lt))
    i = lt
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4)
      if (end === -1) fail('comentário sem fim')
      i = end + 3
    } else if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9)
      if (end === -1) fail('CDATA sem fim')
      if (stack.length) stack.at(-1)!.text += source.slice(i + 9, end)
      i = end + 3
    } else if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2)
      if (end === -1) fail('instrução sem fim')
      i = end + 2
    } else if (source.startsWith('<!', i)) {
      // DOCTYPE (com subconjunto interno entre colchetes): ignorado, entidades declaradas nunca são expandidas.
      let depth = 0
      for (i += 2; i < n; i++) {
        if (source[i] === '[') depth++
        else if (source[i] === ']') depth--
        else if (source[i] === '>' && depth <= 0) break
      }
      i++
    } else if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i)
      if (end === -1) fail('tag de fechamento sem fim')
      const name = source.slice(i + 2, end).trim()
      const open = stack.pop()
      if (!open || open.name !== name) fail(`</${name}> não fecha <${open?.name ?? '?'}>`)
      i = end + 1
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)/.exec(source.slice(i, i + 256))
      if (!m) fail('nome de elemento inválido')
      const name = m![1]!
      i += m![0].length
      const attrs: Record<string, string> = {}
      let selfClosing = false
      for (;;) {
        while (i < n && /\s/.test(source[i]!)) i++
        if (source.startsWith('/>', i)) {
          selfClosing = true
          i += 2
          break
        }
        if (source[i] === '>') {
          i++
          break
        }
        const a = /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(source.slice(i, i + 65536))
        if (!a) fail(`atributo inválido em <${name}>`)
        attrs[a![1]!] = decodeEntities(a![3] ?? a![4] ?? '')
        i += a![0].length
      }
      const parent = stack.at(-1)
      const scope: Record<string, string> = { ...(parent?.scope ?? { xml: XML_NS }) }
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'xmlns') scope[''] = v
        else if (k.startsWith('xmlns:')) scope[k.slice(6)] = v
      }
      const colon = name.indexOf(':')
      const prefix = colon === -1 ? '' : name.slice(0, colon)
      const el: XmlElement = { name, local: colon === -1 ? name : name.slice(colon + 1), ns: scope[prefix] ?? '', attrs, children: [], text: '', scope }
      if (parent) parent.children.push(el)
      else if (root) fail('mais de um elemento raiz')
      else root = el
      if (!selfClosing) stack.push(el)
    }
  }
  if (stack.length) fail(`<${stack.at(-1)!.name}> sem fechamento`)
  if (!root) fail('nenhum elemento')
  return root!
}

/** Resolve um QName de atributo (`tns:Pedido`) para `{namespace}local`. */
export function qname(el: XmlElement, value: string | undefined): { ns: string; local: string } | undefined {
  if (!value) return undefined
  const colon = value.indexOf(':')
  const prefix = colon === -1 ? '' : value.slice(0, colon)
  return { ns: el.scope[prefix] ?? '', local: colon === -1 ? value : value.slice(colon + 1) }
}

export const children = (el: XmlElement, local: string, ns?: string): XmlElement[] =>
  el.children.filter((c) => c.local === local && (ns === undefined || c.ns === ns))

export const child = (el: XmlElement, local: string, ns?: string): XmlElement | undefined => children(el, local, ns)[0]

/** Escapa texto para dentro de um elemento ou atributo. */
export const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
