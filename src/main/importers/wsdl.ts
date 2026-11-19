import { baseName, type ForeignConversion } from './foreign'
import type { ImportWarning } from './postman'
import { child, children, escapeXml, parseXml, qname, type XmlElement } from './xml'

/**
 * Importador de WSDL 1.1 (SOAP 1.1 e 1.2). Cada serviço vira uma coleção, com a URL do
 * `soap:address` como base, e cada operação do binding SOAP vira uma requisição POST com o
 * `SOAPAction` (ou o `action` do `Content-Type` no SOAP 1.2) e um envelope de exemplo montado do
 * XSD dos tipos: elementos com o valor de exemplo pelo tipo, opcionais e repetições comentados como
 * no SoapUI. Estilos document/literal (inclusive wrapped) e rpc. Schemas importados de outros
 * arquivos não são buscados: o elemento fica sem os campos, com aviso.
 */

const NS = {
  wsdl: 'http://schemas.xmlsoap.org/wsdl/',
  wsdl2: 'http://www.w3.org/ns/wsdl',
  soap11: 'http://schemas.xmlsoap.org/wsdl/soap/',
  soap12: 'http://schemas.xmlsoap.org/wsdl/soap12/',
  xsd: 'http://www.w3.org/2001/XMLSchema'
}

const ENVELOPE = {
  '1.1': 'http://schemas.xmlsoap.org/soap/envelope/',
  '1.2': 'http://www.w3.org/2003/05/soap-envelope'
}

/** Texto de import que é um WSDL (o leitor entrega XML como `{ $text }`). */
export function isWsdlText(text: string): boolean {
  const head = text.slice(0, 4096)
  return (
    (/<([\w-]+:)?definitions[\s>]/.test(head) && /schemas\.xmlsoap\.org\/wsdl\//.test(head)) ||
    (/<([\w-]+:)?description[\s>]/.test(head) && /www\.w3\.org\/ns\/wsdl/.test(head))
  )
}

interface Schema {
  ns: string
  qualified: boolean
  el: XmlElement
}

type Key = string
const key = (ns: string, local: string): Key => `{${ns}}${local}`

interface Operation {
  name: string
  action: string
  style: 'document' | 'rpc'
  bodyNamespace?: string
  input?: { ns: string; local: string }
  documentation?: string
}

export function convertWsdl(file: string, text: string): ForeignConversion {
  const warnings: ImportWarning[] = []
  const out: ForeignConversion = { format: 'wsdl', name: baseName(file), postman: [], warnings, errors: [] }
  let root: XmlElement
  try {
    root = parseXml(text)
  } catch (err) {
    out.errors.push({ file, message: (err as Error).message })
    return out
  }
  if (root.ns === NS.wsdl2) {
    out.errors.push({ file, message: 'WSDL 2.0 não é suportado; exporte o serviço como WSDL 1.1' })
    return out
  }
  if (root.local !== 'definitions' || root.ns !== NS.wsdl) {
    out.errors.push({ file, message: 'não parece um WSDL 1.1 (wsdl:definitions)' })
    return out
  }
  const target = root.attrs['targetNamespace'] ?? ''
  const docName = root.attrs['name']?.trim() || baseName(file)
  out.name = docName

  // Tipos: todos os xsd:schema do documento, indexados por {namespace}nome.
  const schemas: Schema[] = []
  for (const types of children(root, 'types', NS.wsdl)) {
    for (const s of children(types, 'schema', NS.xsd)) {
      schemas.push({ ns: s.attrs['targetNamespace'] ?? target, qualified: s.attrs['elementFormDefault'] === 'qualified', el: s })
    }
  }
  const index = { elements: new Map<Key, [XmlElement, Schema]>(), types: new Map<Key, [XmlElement, Schema]>() }
  let external = 0
  for (const s of schemas) {
    for (const c of s.el.children) {
      if (c.ns !== NS.xsd) continue
      if ((c.local === 'import' || c.local === 'include') && c.attrs['schemaLocation']) external++
      const name = c.attrs['name']
      if (!name) continue
      if (c.local === 'element') index.elements.set(key(s.ns, name), [c, s])
      else if (c.local === 'complexType' || c.local === 'simpleType') index.types.set(key(s.ns, name), [c, s])
    }
  }
  if (children(root, 'import', NS.wsdl).length || external) {
    warnings.push({ source: docName, message: 'o WSDL importa schemas ou WSDLs de outros arquivos, que não são buscados: os elementos de lá ficam sem os campos no exemplo.' })
  }

  const messages = new Map<string, { name: string; element?: { ns: string; local: string }; type?: { ns: string; local: string } }[]>()
  for (const m of children(root, 'message', NS.wsdl)) {
    messages.set(
      key(target, m.attrs['name'] ?? ''),
      children(m, 'part', NS.wsdl).map((p) => ({ name: p.attrs['name'] ?? 'part', element: qname(p, p.attrs['element']), type: qname(p, p.attrs['type']) }))
    )
  }
  const portTypes = new Map<string, Map<string, { input?: string; documentation?: string }>>()
  for (const pt of children(root, 'portType', NS.wsdl)) {
    const ops = new Map<string, { input?: string; documentation?: string }>()
    for (const op of children(pt, 'operation', NS.wsdl)) {
      const input = child(op, 'input', NS.wsdl)
      const q = input ? qname(input, input.attrs['message']) : undefined
      ops.set(op.attrs['name'] ?? '', { input: q && key(q.ns, q.local), documentation: child(op, 'documentation', NS.wsdl)?.text.trim() || undefined })
    }
    portTypes.set(key(target, pt.attrs['name'] ?? ''), ops)
  }
  const bindings = new Map<string, { version: '1.1' | '1.2'; operations: Operation[] }>()
  for (const b of children(root, 'binding', NS.wsdl)) {
    const soap = child(b, 'binding', NS.soap11) ?? child(b, 'binding', NS.soap12)
    if (!soap) continue
    const version = soap.ns === NS.soap12 ? '1.2' : '1.1'
    const type = qname(b, b.attrs['type'])
    const ops = (type && portTypes.get(key(type.ns, type.local))) ?? new Map()
    const operations: Operation[] = []
    for (const op of children(b, 'operation', NS.wsdl)) {
      const name = op.attrs['name'] ?? ''
      const soapOp = child(op, 'operation', soap.ns)
      const style = (soapOp?.attrs['style'] ?? soap.attrs['style'] ?? 'document') === 'rpc' ? 'rpc' : 'document'
      const input = child(op, 'input', NS.wsdl)
      const body = input ? child(input, 'body', soap.ns) : undefined
      const pt = ops.get(name)
      const inputKey = pt?.input
      operations.push({
        name,
        action: soapOp?.attrs['soapAction'] ?? '',
        style,
        bodyNamespace: body?.attrs['namespace'],
        input: inputKey ? { ns: '', local: inputKey } : undefined,
        documentation: pt?.documentation ?? (child(op, 'documentation', NS.wsdl)?.text.trim() || undefined)
      })
    }
    bindings.set(key(target, b.attrs['name'] ?? ''), { version, operations })
  }

  const sample = new Sampler(index, warnings, docName)
  const collections: { name: string; data: Record<string, unknown> }[] = []
  for (const service of children(root, 'service', NS.wsdl)) {
    const serviceName = service.attrs['name']?.trim() || docName
    const ports = children(service, 'port', NS.wsdl)
      .map((p) => {
        const b = qname(p, p.attrs['binding'])
        const binding = b && bindings.get(key(b.ns, b.local))
        const address = child(p, 'address', NS.soap11) ?? child(p, 'address', NS.soap12)
        return binding && address ? { name: p.attrs['name'] ?? '', binding, location: address.attrs['location'] ?? '' } : undefined
      })
      .filter((p): p is NonNullable<typeof p> => !!p)
    if (!ports.length) continue
    // SOAP 1.1 e 1.2 do mesmo serviço costumam ter as mesmas operações: fica o 1.1, que é o mais aceito.
    const soap11 = ports.filter((p) => p.binding.version === '1.1')
    const chosen = soap11.length ? soap11 : ports
    if (soap11.length && soap11.length < ports.length) {
      warnings.push({ source: serviceName, message: 'o serviço também tem portas SOAP 1.2; ficaram as SOAP 1.1, com as mesmas operações.' })
    }
    const multi = chosen.length > 1
    const folders = chosen.map((port) => ({
      name: port.name,
      item: port.binding.operations.map((op) => {
        const envelope = buildEnvelope(op, port.binding.version, target, messages, sample)
        const headers =
          port.binding.version === '1.1'
            ? [
                { key: 'Content-Type', value: 'text/xml; charset=utf-8' },
                { key: 'SOAPAction', value: `"${op.action}"` }
              ]
            : [{ key: 'Content-Type', value: `application/soap+xml; charset=utf-8${op.action ? `; action="${op.action}"` : ''}` }]
        return {
          name: op.name,
          request: {
            method: 'POST',
            url: { raw: port.location },
            header: headers,
            body: { mode: 'raw', raw: envelope, options: { raw: { language: 'xml' } } },
            ...(op.documentation && { description: op.documentation })
          }
        }
      })
    }))
    const documentation = child(service, 'documentation', NS.wsdl)?.text.trim() || child(root, 'documentation', NS.wsdl)?.text.trim()
    collections.push({
      name: serviceName,
      data: {
        info: { name: serviceName, ...(documentation && { description: documentation }), schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: multi ? folders : folders[0]!.item
      }
    })
  }
  if (!collections.length) {
    out.errors.push({ file, message: 'o WSDL não tem serviço com binding SOAP e endereço (soap:address)' })
    return out
  }
  out.name = collections.map((c) => c.name).join(', ')
  for (const c of collections) out.postman.push({ file, tool: 'WSDL', data: c.data })
  return out
}

function buildEnvelope(
  op: Operation,
  version: '1.1' | '1.2',
  target: string,
  messages: Map<string, { name: string; element?: { ns: string; local: string }; type?: { ns: string; local: string } }[]>,
  sample: Sampler
): string {
  const parts = (op.input && messages.get(op.input.local)) ?? []
  const ns = new Namespaces()
  const lines: string[] = []
  if (op.style === 'rpc') {
    const wrapper = ns.prefix(op.bodyNamespace ?? target)
    lines.push(`<${wrapper}:${op.name}>`)
    for (const p of parts) lines.push(...sample.part(p.name, p.type, p.element, ns).map((l) => `  ${l}`))
    lines.push(`</${wrapper}:${op.name}>`)
  } else {
    for (const p of parts) {
      if (p.element) lines.push(...sample.element(p.element, ns))
      else lines.push(...sample.part(p.name, p.type, undefined, ns))
    }
  }
  const env = version === '1.1' ? ENVELOPE['1.1'] : ENVELOPE['1.2']
  const decls = [`xmlns:soapenv="${env}"`, ...ns.declarations()].join(' ')
  return [
    `<soapenv:Envelope ${decls}>`,
    '  <soapenv:Header/>',
    '  <soapenv:Body>',
    ...lines.map((l) => `    ${l}`),
    '  </soapenv:Body>',
    '</soapenv:Envelope>'
  ].join('\n')
}

class Namespaces {
  private byUri = new Map<string, string>()
  prefix(uri: string): string {
    let p = this.byUri.get(uri)
    if (!p) {
      p = this.byUri.size === 0 ? 'tns' : `ns${this.byUri.size}`
      this.byUri.set(uri, p)
    }
    return p
  }
  declarations(): string[] {
    return [...this.byUri].map(([uri, p]) => `xmlns:${p}="${escapeXml(uri)}"`)
  }
}

const MAX_DEPTH = 8

/** Exemplo de XML a partir do XSD, no estilo do SoapUI. */
class Sampler {
  private missing = new Set<string>()

  constructor(
    private readonly index: { elements: Map<Key, [XmlElement, Schema]>; types: Map<Key, [XmlElement, Schema]> },
    private readonly warnings: ImportWarning[],
    private readonly source: string
  ) {}

  element(q: { ns: string; local: string }, ns: Namespaces): string[] {
    const found = this.index.elements.get(key(q.ns, q.local))
    if (!found) {
      this.warnMissing(q.local)
      return [`<${ns.prefix(q.ns)}:${q.local}>?</${ns.prefix(q.ns)}:${q.local}>`]
    }
    return this.renderElement(found[0], found[1], ns, true, 0, [])
  }

  /** Parte rpc ou document por `type`: elemento sem namespace com o nome da parte. */
  part(name: string, type: { ns: string; local: string } | undefined, element: { ns: string; local: string } | undefined, ns: Namespaces): string[] {
    if (element) return this.element(element, ns)
    if (!type) return [`<${name}>?</${name}>`]
    return this.renderTyped(name, type, ns, 0, [])
  }

  private warnMissing(name: string) {
    if (this.missing.has(name)) return
    this.missing.add(name)
    this.warnings.push({ source: this.source, message: `o tipo ou elemento "${name}" não está no WSDL; o exemplo ficou com "?".` })
  }

  private renderElement(el: XmlElement, schema: Schema, ns: Namespaces, topLevel: boolean, depth: number, seen: string[]): string[] {
    const ref = qname(el, el.attrs['ref'])
    if (ref) {
      const found = this.index.elements.get(key(ref.ns, ref.local))
      const target = found ? this.renderElement(found[0], found[1], ns, true, depth, seen) : [`<${ns.prefix(ref.ns)}:${ref.local}>?</${ns.prefix(ref.ns)}:${ref.local}>`]
      return [...occurs(el), ...target]
    }
    const local = el.attrs['name'] ?? 'element'
    const qualified = topLevel || (el.attrs['form'] ? el.attrs['form'] === 'qualified' : schema.qualified)
    const tag = qualified ? `${ns.prefix(schema.ns)}:${local}` : local
    const comments = topLevel ? [] : occurs(el)
    const type = qname(el, el.attrs['type'])
    if (type) return [...comments, ...this.renderTyped(tag, type, ns, depth, seen)]
    const complex = child(el, 'complexType', NS.xsd)
    if (complex) return [...comments, ...this.renderComplex(tag, complex, schema, ns, depth, seen)]
    const simple = child(el, 'simpleType', NS.xsd)
    return [...comments, `<${tag}>${simple ? simpleSample(simple) : '?'}</${tag}>`]
  }

  private renderTyped(tag: string, type: { ns: string; local: string }, ns: Namespaces, depth: number, seen: string[]): string[] {
    if (type.ns === NS.xsd) return [`<${tag}>${builtinSample(type.local)}</${tag}>`]
    const found = this.index.types.get(key(type.ns, type.local))
    if (!found) {
      this.warnMissing(type.local)
      return [`<${tag}>?</${tag}>`]
    }
    const [def, schema] = found
    if (def.local === 'simpleType') return [`<${tag}>${simpleSample(def)}</${tag}>`]
    const id = key(type.ns, type.local)
    if (seen.includes(id) || depth >= MAX_DEPTH) return [`<${tag}/>`, '<!-- tipo recursivo: complete se precisar -->']
    return this.renderComplex(tag, def, schema, ns, depth, [...seen, id])
  }

  private renderComplex(tag: string, complex: XmlElement, schema: Schema, ns: Namespaces, depth: number, seen: string[]): string[] {
    const attrs: string[] = []
    const body = this.content(complex, schema, ns, depth, seen, attrs)
    const open = `${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}`
    if (!body.length) return [`<${open}>${complex.attrs['mixed'] === 'true' ? '?' : ''}</${tag}>`]
    if (body.length === 1 && body[0]!.startsWith('\0')) return [`<${open}>${body[0]!.slice(1)}</${tag}>`]
    return [`<${open}>`, ...body.map((l) => `  ${l}`), `</${tag}>`]
  }

  /** Filhos de um complexType (sequence, all, choice, extensões); `\0valor` é conteúdo simples. */
  private content(complex: XmlElement, schema: Schema, ns: Namespaces, depth: number, seen: string[], attrs: string[]): string[] {
    const lines: string[] = []
    for (const c of complex.children) {
      if (c.ns !== NS.xsd) continue
      switch (c.local) {
        case 'sequence':
        case 'all':
          lines.push(...this.content(c, schema, ns, depth, seen, attrs))
          break
        case 'choice': {
          lines.push('<!-- Uma das opções: -->')
          lines.push(...this.content(c, schema, ns, depth, seen, attrs))
          break
        }
        case 'element':
          lines.push(...this.renderElement(c, schema, ns, false, depth + 1, seen))
          break
        case 'attribute': {
          const name = c.attrs['name']
          const type = qname(c, c.attrs['type'])
          if (name) attrs.push(`${name}="${type?.ns === NS.xsd ? builtinSample(type.local) : '?'}"`)
          break
        }
        case 'complexContent':
        case 'simpleContent': {
          const ext = child(c, 'extension', NS.xsd) ?? child(c, 'restriction', NS.xsd)
          if (!ext) break
          const base = qname(ext, ext.attrs['base'])
          if (c.local === 'simpleContent') {
            lines.push(`\0${base?.ns === NS.xsd ? builtinSample(base.local) : '?'}`)
            this.content(ext, schema, ns, depth, seen, attrs)
            break
          }
          const found = base && base.ns !== NS.xsd ? this.index.types.get(key(base.ns, base.local)) : undefined
          if (found && !seen.includes(key(base!.ns, base!.local))) {
            lines.push(...this.content(found[0], found[1], ns, depth, [...seen, key(base!.ns, base!.local)], attrs))
          }
          if (c.local === 'complexContent' && ext.local === 'extension') lines.push(...this.content(ext, schema, ns, depth, seen, attrs))
          break
        }
        case 'any':
          lines.push('<!-- Qualquer elemento -->')
          break
        case 'group': {
          const ref = qname(c, c.attrs['ref'])
          if (ref) lines.push(`<!-- grupo ${ref.local} -->`)
          break
        }
      }
    }
    return lines
  }
}

function occurs(el: XmlElement): string[] {
  const min = el.attrs['minOccurs']
  const max = el.attrs['maxOccurs']
  if (max === 'unbounded' || (max && Number(max) > 1)) return [min === '0' ? '<!-- Zero ou mais repetições: -->' : '<!-- Uma ou mais repetições: -->']
  if (min === '0') return ['<!-- Opcional: -->']
  return []
}

function simpleSample(simple: XmlElement): string {
  const restriction = child(simple, 'restriction', NS.xsd)
  const first = restriction ? child(restriction, 'enumeration', NS.xsd) : undefined
  if (first?.attrs['value'] !== undefined) return escapeXml(first.attrs['value'])
  const base = restriction ? qname(restriction, restriction.attrs['base']) : undefined
  return base?.ns === NS.xsd ? builtinSample(base.local) : '?'
}

function builtinSample(type: string): string {
  if (/^(int|integer|long|short|byte|nonNegativeInteger|positiveInteger|unsigned\w+|negativeInteger|nonPositiveInteger)$/.test(type)) return '0'
  if (/^(decimal|double|float)$/.test(type)) return '0.0'
  if (type === 'boolean') return 'false'
  if (type === 'dateTime') return '2026-01-01T00:00:00Z'
  if (type === 'date') return '2026-01-01'
  if (type === 'time') return '00:00:00'
  return '?'
}
