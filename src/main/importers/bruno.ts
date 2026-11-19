import {
  asString,
  baseName,
  hasHeader,
  isObject,
  needsContentType,
  postmanAuth,
  postmanUrl,
  rawBody,
  isImportFolder,
  isImportText,
  type ForeignConversion,
  type ImportFolder,
  type KeyValue
} from './foreign'
import type { ImportWarning } from './postman'

/**
 * Importador do Bruno: a pasta da coleção (`bruno.json`, os `.bru` das requisições, `folder.bru`,
 * `collection.bru`, `environments/*.bru` e o `.env`), arquivos `.bru` soltos e a exportação em JSON
 * ("Export collection"). A pasta é lida para o mesmo modelo da exportação, e o modelo vira uma
 * coleção Postman v2.1. `{{process.env.X}}` vira `{{X}}`, e o valor do `.env` vai para o vault.
 * Os scripts (`bru.*`, `req.*`, `res.*`, `test`/`expect`) viram `pm.*`, que segue a tradução para a
 * API `vv`; o bloco `assert` vira testes no script post.
 */

type Obj = Record<string, unknown>

interface BrunoPair {
  name: string
  value: string
  enabled: boolean
  type?: string
}

interface BrunoRequest {
  method?: string
  url?: string
  params?: BrunoPair[]
  headers?: BrunoPair[]
  body?: Obj & { mode?: string }
  auth?: Obj & { mode?: string }
  script?: { req?: string; res?: string }
  vars?: { req?: BrunoPair[]; res?: BrunoPair[] }
  assertions?: BrunoPair[]
  tests?: string
  docs?: string
}

interface BrunoItem {
  type?: string
  name?: string
  seq?: number
  request?: BrunoRequest
  items?: BrunoItem[]
  root?: { request?: BrunoRequest; docs?: string }
}

interface BrunoEnvironment {
  name: string
  variables: { name: string; value: string; enabled: boolean; secret: boolean }[]
}

export interface BrunoCollection {
  name: string
  items: BrunoItem[]
  root?: { request?: BrunoRequest; docs?: string }
  environments?: BrunoEnvironment[]
  /** Valores do `.env` da coleção (`{{process.env.X}}`). */
  dotenv?: Record<string, string>
}

/** Exportação JSON do Bruno ("Export collection"). */
export function isBrunoJson(data: unknown): boolean {
  return (
    isObject(data) &&
    Array.isArray(data['items']) &&
    typeof data['name'] === 'string' &&
    (data['version'] === '1' || isObject(data['brunoConfig']) || (data['items'] as unknown[]).some((i) => isObject(i) && /^(http|graphql)-request$|^folder$/.test(asString(i['type']))))
  )
}

export const isBrunoFolder = (data: unknown): boolean =>
  isImportFolder(data) && Object.keys(data.$folder).some((p) => p === 'bruno.json' || p.endsWith('.bru'))

export const isBruFile = (file: string, data: unknown): boolean => isImportText(data) && /\.bru$/i.test(file)

// ---------------------------------------------------------------------------
// Formato .bru

interface BruBlock {
  name: string
  /** Pares `chave: valor` (blocos de dicionário). */
  pairs: BrunoPair[]
  /** Texto do bloco (corpo, script, testes, docs). */
  text: string
  /** Itens de uma lista (`vars:secret [ a, b ]`). */
  list: string[]
}

const TEXT_BLOCKS = /^(body(:json|:text|:xml|:sparql|:graphql|:graphql:vars)?|script:.*|tests|docs)$/

/** Lê um `.bru`: blocos `nome {` ... `}` na coluna zero, com o conteúdo recuado em dois espaços. */
export function parseBru(source: string): Map<string, BruBlock> {
  const blocks = new Map<string, BruBlock>()
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!.match(/^([A-Za-z][\w:-]*)\s*([{[])\s*$/)
    if (!open) continue
    const name = open[1]!
    const close = open[2] === '{' ? '}' : ']'
    const body: string[] = []
    for (i++; i < lines.length && lines[i]!.trimEnd() !== close; i++) body.push(lines[i]!)
    const block: BruBlock = { name, pairs: [], text: '', list: [] }
    if (close === ']') {
      block.list = body.join(',').split(',').map((s) => s.trim()).filter(Boolean)
    } else if (TEXT_BLOCKS.test(name)) {
      block.text = body.map((l) => l.replace(/^ {2}/, '')).join('\n').trim()
    } else {
      for (let j = 0; j < body.length; j++) {
        const m = body[j]!.match(/^\s+(~?)([^:]+?)\s*:\s?(.*)$/)
        if (!m) continue
        let value = m[3]!
        // Valor de várias linhas: '''...'''
        if (value.trim() === "'''") {
          const multi: string[] = []
          for (j++; j < body.length && body[j]!.trim() !== "'''"; j++) multi.push(body[j]!.replace(/^ {4}/, ''))
          value = multi.join('\n')
        }
        block.pairs.push({ name: unquote(m[2]!.trim()), value, enabled: m[1] !== '~' })
      }
    }
    blocks.set(name, block)
  }
  return blocks
}

const unquote = (s: string) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s)

const METHOD_BLOCKS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'connect', 'trace']

/** Um `.bru` de requisição (ou de pasta, ou de coleção) para o modelo da exportação JSON. */
function bruRequest(blocks: Map<string, BruBlock>): { name?: string; seq?: number; type?: string; request: BrunoRequest; docs?: string } {
  const dict = (name: string) => Object.fromEntries((blocks.get(name)?.pairs ?? []).map((p) => [p.name, p.value]))
  const meta = dict('meta')
  const methodBlock = METHOD_BLOCKS.find((m) => blocks.has(m))
  const http = methodBlock ? dict(methodBlock) : {}
  const request: BrunoRequest = {
    ...(methodBlock && { method: methodBlock.toUpperCase(), url: asString(http['url']) }),
    params: [
      ...(blocks.get('params:query')?.pairs ?? []).map((p) => ({ ...p, type: 'query' })),
      ...(blocks.get('params:path')?.pairs ?? []).map((p) => ({ ...p, type: 'path' }))
    ],
    headers: blocks.get('headers')?.pairs ?? [],
    script: { req: blocks.get('script:pre-request')?.text, res: blocks.get('script:post-response')?.text },
    vars: { req: blocks.get('vars:pre-request')?.pairs, res: blocks.get('vars:post-response')?.pairs },
    assertions: blocks.get('assert')?.pairs,
    tests: blocks.get('tests')?.text,
    docs: blocks.get('docs')?.text
  }
  // Modo do corpo e da auth: no bloco do método (requisição) ou nos blocos auth/body (pasta e coleção).
  const bodyMode = asString(http['body'] ?? '') || (blocks.has('body:json') ? 'json' : '')
  const body: Obj & { mode?: string } = { mode: bodyMode || 'none' }
  const bodyText = (n: string) => blocks.get(n)?.text
  if (bodyText('body:json') !== undefined) body['json'] = bodyText('body:json')
  if (bodyText('body:text') !== undefined) body['text'] = bodyText('body:text')
  if (bodyText('body:xml') !== undefined) body['xml'] = bodyText('body:xml')
  if (bodyText('body:sparql') !== undefined) body['sparql'] = bodyText('body:sparql')
  if (blocks.has('body:graphql')) body['graphql'] = { query: bodyText('body:graphql') ?? '', variables: bodyText('body:graphql:vars') ?? '' }
  if (blocks.has('body:form-urlencoded')) body['formUrlEncoded'] = blocks.get('body:form-urlencoded')!.pairs
  if (blocks.has('body:multipart-form')) {
    body['multipartForm'] = blocks.get('body:multipart-form')!.pairs.map((p) => {
      const file = p.value.match(/^@file\((.*)\)/)
      return file ? { ...p, type: 'file', value: file[1]!.split('|')[0] } : { ...p, type: 'text' }
    })
  }
  if (blocks.has('body:file')) {
    const file = blocks.get('body:file')!.pairs.find((p) => p.enabled && /@file\(/.test(p.value))
    if (file) body['file'] = [{ filePath: file.value.match(/@file\(([^)]*)\)/)![1], selected: true }]
  }
  request.body = body
  // Sem modo declarado (pasta ou coleção sem bloco auth), herda.
  const authMode = asString(http['auth'] ?? dict('auth')['mode'] ?? '') || 'inherit'
  const auth: Obj & { mode?: string } = { mode: authMode }
  for (const [key, block] of blocks) {
    const m = key.match(/^auth:(\w+)$/)
    if (m) auth[m[1]!] = Object.fromEntries(block.pairs.map((p) => [p.name, p.value]))
  }
  request.auth = auth
  return {
    name: meta['name'],
    seq: Number(meta['seq']) || undefined,
    type: meta['type'] === 'graphql' ? 'graphql-request' : 'http-request',
    request,
    docs: request.docs
  }
}

/** A pasta da coleção para o modelo da exportação JSON. */
export function readBrunoFolder(folder: ImportFolder): BrunoCollection {
  const files = folder.$folder
  let name = folder.name
  try {
    const config = JSON.parse(files['bruno.json'] ?? '{}') as { name?: string }
    if (config.name?.trim()) name = config.name.trim()
  } catch {
    // bruno.json quebrado: fica o nome da pasta.
  }
  const collection: BrunoCollection = { name, items: [], environments: [] }
  if (files['collection.bru']) {
    const root = bruRequest(parseBru(files['collection.bru']))
    collection.root = { request: root.request, docs: root.docs }
  }
  const folders = new Map<string, BrunoItem>([['', { type: 'folder', items: collection.items }]])
  const folderOf = (dir: string): BrunoItem => {
    let f = folders.get(dir)
    if (f) return f
    const parent = folderOf(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')
    f = { type: 'folder', name: dir.split('/').pop(), items: [] }
    const meta = files[`${dir}/folder.bru`]
    if (meta) {
      const parsed = bruRequest(parseBru(meta))
      f.name = parsed.name || f.name
      f.seq = parsed.seq
      f.root = { request: parsed.request, docs: parsed.docs }
    }
    parent.items!.push(f)
    folders.set(dir, f)
    return f
  }
  for (const path of Object.keys(files).sort()) {
    if (!path.endsWith('.bru') || path === 'collection.bru' || path.endsWith('/folder.bru') || path === 'folder.bru') continue
    if (path.startsWith('environments/')) {
      collection.environments!.push(bruEnvironment(baseName(path), files[path]!))
      continue
    }
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const parsed = bruRequest(parseBru(files[path]!))
    if (!parsed.request.method) continue
    folderOf(dir).items!.push({ type: parsed.type, name: parsed.name || baseName(path), seq: parsed.seq, request: parsed.request })
  }
  if (files['.env']) collection.dotenv = parseDotenv(files['.env'])
  return collection
}

function bruEnvironment(name: string, source: string): BrunoEnvironment {
  const blocks = parseBru(source)
  const secrets = new Set(blocks.get('vars:secret')?.list.map((s) => s.replace(/^~/, '')) ?? [])
  const variables = (blocks.get('vars')?.pairs ?? []).map((p) => ({ name: p.name, value: p.value, enabled: p.enabled, secret: secrets.has(p.name) }))
  for (const s of secrets) if (!variables.some((v) => v.name === s)) variables.push({ name: s, value: '', enabled: true, secret: true })
  return { name, variables }
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

// ---------------------------------------------------------------------------
// Para a coleção v2.1

export function convertBruno(file: string, data: unknown, looseFiles: { file: string; text: string }[] = []): ForeignConversion {
  const warnings: ImportWarning[] = []
  const out: ForeignConversion = { format: 'bruno', name: baseName(file), postman: [], warnings, errors: [] }
  let collection: BrunoCollection
  if (isImportFolder(data)) collection = readBrunoFolder(data)
  else if (isBrunoJson(data)) collection = data as unknown as BrunoCollection
  else if (looseFiles.length) collection = looseCollection(file, looseFiles)
  else {
    out.errors.push({ file, message: 'não parece uma coleção do Bruno (pasta, .bru ou exportação JSON)' })
    return out
  }
  out.name = collection.name || baseName(file)
  const conv = new Converter(out.name, warnings, collection.dotenv ?? {})
  const postman = conv.collection(collection)
  if (!(postman['item'] as unknown[]).length) {
    out.errors.push({ file, message: 'a coleção do Bruno não tem requisições HTTP' })
    return out
  }
  out.postman.push({ file, tool: 'Bruno', data: postman })
  for (const env of conv.environments(collection.environments ?? [])) out.postman.push({ file, tool: 'Bruno', data: env })
  conv.finish()
  return out
}

/** `.bru` escolhidos soltos: as requisições numa coleção, os ambientes (só `vars`) como ambientes. */
function looseCollection(file: string, files: { file: string; text: string }[]): BrunoCollection {
  const collection: BrunoCollection = { name: baseName(file), items: [], environments: [] }
  for (const f of files) {
    const blocks = parseBru(f.text)
    const parsed = bruRequest(blocks)
    if (parsed.request.method) collection.items.push({ type: parsed.type, name: parsed.name || baseName(f.file), seq: parsed.seq, request: parsed.request })
    else if (blocks.has('vars') || blocks.has('vars:secret')) collection.environments!.push(bruEnvironment(baseName(f.file), f.text))
  }
  return collection
}

const BODY_MIME: Record<string, string> = { json: 'application/json', xml: 'application/xml', text: 'text/plain', sparql: 'application/sparql-query' }

class Converter {
  private assertions = { converted: 0, skipped: new Set<string>() }
  private dotenvUsed = new Set<string>()
  private variables = new Map<string, string>()

  constructor(
    private readonly name: string,
    private readonly warnings: ImportWarning[],
    private readonly dotenv: Record<string, string>
  ) {}

  private warn(source: string, message: string) {
    this.warnings.push({ source, message })
  }

  text(value: unknown): string {
    return asString(value).replace(/\{\{\s*process\.env\.([\w.-]+)\s*\}\}/g, (_m, name: string) => {
      this.dotenvUsed.add(name)
      return `{{${name}}}`
    })
  }

  collection(c: BrunoCollection): Obj {
    const root = c.root?.request
    const items = this.items(c.items ?? [], this.name, root?.headers ?? [])
    const scripts = this.events(root, this.name)
    const auth = this.auth(root?.auth, this.name)
    for (const v of root?.vars?.req ?? []) if (v.enabled) this.variables.set(v.name, this.text(v.value))
    return {
      info: {
        name: this.name,
        ...(c.root?.docs && { description: c.root.docs }),
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: items,
      ...(auth && { auth }),
      ...(scripts.length && { event: scripts }),
      ...(this.variables.size && { variable: [...this.variables].map(([key, value]) => ({ key, value })) })
    }
  }

  private items(items: BrunoItem[], trail: string, headers: BrunoPair[]): Obj[] {
    const sorted = [...items].sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER))
    const out: Obj[] = []
    let skipped = 0
    for (const item of sorted) {
      if (!item || typeof item !== 'object') continue
      const name = item.name?.trim() || 'Sem nome'
      const here = `${trail} › ${name}`
      if (item.type === 'folder' || Array.isArray(item.items)) {
        const req = item.root?.request
        for (const v of req?.vars?.req ?? []) {
          if (!v.enabled) continue
          if (this.variables.has(v.name) && this.variables.get(v.name) !== this.text(v.value)) {
            this.warn(here, `a variável "${v.name}" da pasta tem outro valor em outro lugar; no VVPost as variáveis são do ambiente, ficou a primeira.`)
          } else this.variables.set(v.name, this.text(v.value))
        }
        const event = this.events(req, here)
        const auth = this.auth(req?.auth, here)
        out.push({
          name,
          ...(item.root?.docs && { description: item.root.docs }),
          item: this.items(item.items ?? [], here, [...headers, ...(req?.headers ?? [])]),
          ...(auth && { auth }),
          ...(event.length && { event })
        })
        continue
      }
      if (item.type && !/^(http|graphql)-request$/.test(item.type)) {
        skipped++
        continue
      }
      const r = item.request ?? {}
      out.push(this.request(r, name, here, headers, item.type === 'graphql-request'))
    }
    if (skipped) this.warn(trail, `${skipped} requisição(ões) gRPC ou WebSocket do Bruno ficaram de fora: crie no Quick Request.`)
    return out
  }

  private request(r: BrunoRequest, name: string, trail: string, inherited: BrunoPair[], graphql: boolean): Obj {
    const header: KeyValue[] = []
    for (const h of [...inherited, ...(r.headers ?? [])]) {
      if (!h?.enabled || !h.name) continue
      const existing = header.findIndex((x) => x.key.toLowerCase() === h.name.toLowerCase())
      if (existing !== -1) header.splice(existing, 1)
      header.push({ key: h.name, value: this.text(h.value) })
    }
    // A URL do Bruno já traz a query; os params:query desligados (~) ficam de fora dela.
    const url = postmanUrl(this.text(r.url ?? ''))
    const body = this.body(r.body, header, trail, graphql)
    const auth = this.auth(r.auth, trail)
    const event = this.events(r, trail)
    return {
      name,
      request: {
        method: (r.method ?? 'GET').toUpperCase(),
        url,
        header,
        ...(body && { body }),
        ...(auth && { auth }),
        ...(r.docs && { description: r.docs })
      },
      ...(event.length && { event })
    }
  }

  private body(body: BrunoRequest['body'], headers: KeyValue[], trail: string, graphql: boolean): Obj | undefined {
    if (!body) return undefined
    const mode = graphql ? 'graphql' : asString(body.mode)
    const fields = (list: unknown) =>
      (Array.isArray(list) ? (list as BrunoPair[]) : []).map((p) => ({
        key: p.name,
        value: p.type === 'file' ? '' : this.text(p.value),
        disabled: !p.enabled,
        ...(p.type === 'file' && { type: 'file', src: asString(p.value) })
      }))
    switch (mode) {
      case 'json':
      case 'text':
      case 'xml':
      case 'sparql': {
        const text = this.text(body[mode])
        if (!text.trim()) return undefined
        const mime = BODY_MIME[mode]!
        if (needsContentType(mime) && !hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value: mime })
        return rawBody(text, mime)
      }
      case 'formUrlEncoded':
        return { mode: 'urlencoded', urlencoded: fields(body['formUrlEncoded']) }
      case 'multipartForm':
        return { mode: 'formdata', formdata: fields(body['multipartForm']) }
      case 'graphql': {
        const g = isObject(body['graphql']) ? body['graphql'] : {}
        return { mode: 'graphql', graphql: { query: this.text(g['query']), variables: this.text(g['variables']) } }
      }
      case 'file': {
        const files = Array.isArray(body['file']) ? (body['file'] as Obj[]) : []
        const chosen = files.find((f) => f['selected'] !== false) ?? files[0]
        return chosen ? { mode: 'file', file: { src: asString(chosen['filePath']) } } : undefined
      }
      case 'none':
      case '':
        return undefined
      default:
        this.warn(trail, `corpo "${mode}" do Bruno não é suportado e ficou de fora.`)
        return undefined
    }
  }

  /** Auth do Bruno para a da coleção v2.1. */
  private auth(auth: BrunoRequest['auth'], trail: string): Obj | undefined {
    const mode = asString(auth?.mode)
    if (!auth || !mode || mode === 'inherit') return undefined
    const p = (isObject(auth[mode]) ? auth[mode] : {}) as Obj
    const t = (k: string) => this.text(p[k])
    switch (mode) {
      case 'none':
        return { type: 'noauth' }
      case 'bearer':
        return postmanAuth('bearer', { token: t('token') })
      case 'basic':
        return postmanAuth('basic', { username: t('username'), password: t('password') })
      case 'apikey':
        return postmanAuth('apikey', { key: t('key'), value: t('value'), in: p['placement'] === 'queryparams' ? 'query' : 'header' })
      case 'digest':
        return postmanAuth('digest', { username: t('username'), password: t('password') })
      case 'ntlm':
        return postmanAuth('ntlm', { username: t('username'), password: t('password'), domain: t('domain') })
      case 'awsv4':
        if (t('profileName')) this.warn(trail, 'o perfil da AWS do Bruno não é lido: preencha a access key e a secret key no ambiente.')
        return postmanAuth('awsv4', {
          accessKey: t('accessKeyId'),
          secretKey: t('secretAccessKey'),
          sessionToken: t('sessionToken'),
          region: t('region'),
          service: t('service')
        })
      case 'oauth2': {
        const grant = t('grant_type') || t('grantType')
        return postmanAuth('oauth2', {
          grant_type: grant === 'password' ? 'password_credentials' : grant,
          accessTokenUrl: t('access_token_url') || t('accessTokenUrl'),
          clientId: t('client_id') || t('clientId'),
          clientSecret: t('client_secret') || t('clientSecret'),
          scope: t('scope'),
          username: t('username'),
          password: t('password'),
          client_authentication: /body/i.test(t('credentials_placement') || t('credentialsPlacement')) ? 'body' : 'header'
        })
      }
      default:
        this.warn(trail, `autenticação "${mode}" do Bruno não é suportada e foi ignorada.`)
        return undefined
    }
  }

  /** Scripts, variáveis de requisição, asserções e testes do Bruno como eventos do Postman. */
  private events(r: BrunoRequest | undefined, trail: string): Obj[] {
    if (!r) return []
    const pre: string[] = []
    const post: string[] = []
    for (const v of r.vars?.req ?? []) {
      if (v.enabled && r.method) pre.push(`pm.variables.set(${JSON.stringify(v.name)}, ${JSON.stringify(this.text(v.value))});`)
    }
    if (r.script?.req?.trim()) pre.push(this.script(r.script.req, trail))
    if (r.script?.res?.trim()) post.push(this.script(r.script.res, trail))
    for (const v of r.vars?.res ?? []) {
      if (!v.enabled) continue
      const expr = this.expression(v.value.trim())
      if (expr) post.push(`pm.variables.set(${JSON.stringify(v.name)}, ${expr});`)
      else this.assertions.skipped.add(v.value.trim())
    }
    for (const a of r.assertions ?? []) {
      if (!a.enabled) continue
      const code = this.assertion(a.name.trim(), a.value.trim())
      if (code) {
        post.push(code)
        this.assertions.converted++
      } else this.assertions.skipped.add(`${a.name}: ${a.value}`)
    }
    if (r.tests?.trim()) post.push(this.script(r.tests, trail))
    return [
      ...(pre.length ? [{ listen: 'prerequest', script: { exec: pre.join('\n') } }] : []),
      ...(post.length ? [{ listen: 'test', script: { exec: post.join('\n') } }] : [])
    ]
  }

  /** `bru.*`, `req.*`, `res.*`, `test` e `expect` para o `pm.*`. */
  private script(code: string, trail: string): string {
    let out = this.text(code)
    for (const [re, to] of SCRIPT_RULES) out = out.replace(re, to)
    const left = new Set<string>()
    for (const m of out.matchAll(/(?<![.\w$])(bru|req|res)\.[A-Za-z_$][\w$]*/g)) left.add(m[0])
    if (left.size) {
      this.warn(trail, `script usa ${[...left].sort().join(', ')} sem equivalente no VVPost; ficou no script como está e vai falhar ao rodar até ser reescrito.`)
    }
    return out
  }

  /** `res.body.a.b`, `res.status`, `res.headers.x`... como expressão do `pm.*`. */
  private expression(lhs: string): string | undefined {
    if (lhs === 'res.status' || lhs === 'res.getStatus()') return 'pm.response.code'
    if (lhs === 'res.responseTime' || lhs === 'res.getResponseTime()') return 'pm.response.responseTime'
    const header = lhs.match(/^res\.headers(?:\.([\w-]+)|\[\s*(['"])([^'"]+)\2\s*\])$/)
    if (header) return `pm.response.headers.get(${JSON.stringify(header[1] ?? header[3])})`
    const body = lhs.match(/^res\.body((?:\.[A-Za-z_$][\w$]*|\[\s*\d+\s*\]|\[\s*(['"])[^'"]+\2\s*\])*)$/)
    if (body) return `pm.response.json()${body[1]}`
    return undefined
  }

  private assertion(lhs: string, rule: string): string | undefined {
    const actual = this.expression(lhs)
    if (!actual) return undefined
    const m = rule.match(/^(\w+)\s*(.*)$/)
    if (!m) return undefined
    const [, op, raw] = m as unknown as [string, string, string]
    const value = literal(raw)
    const chain = ASSERT_OPS[op]?.(value, raw)
    if (!chain) return undefined
    // eq com número de status fica no formato que o importador também transforma em cenário.
    const code = op === 'eq' && actual === 'pm.response.code' ? `pm.expect(pm.response.code).to.equal(${value})` : `pm.expect(${actual})${chain}`
    return `pm.test(${JSON.stringify(`${lhs} ${rule}`)}, function () { ${code}; });`
  }

  environments(envs: BrunoEnvironment[]): Obj[] {
    const out: Obj[] = envs.map((e) => ({
      name: `${this.name} (${e.name})`,
      values: (e.variables ?? []).map((v) => ({
        key: v.name,
        value: this.text(v.value),
        enabled: v.enabled !== false,
        ...(v.secret && { type: 'secret' })
      }))
    }))
    const dotenv = Object.entries(this.dotenv).filter(([k]) => this.dotenvUsed.has(k))
    if (dotenv.length) {
      // O .env do Bruno é o lugar dos segredos: tudo dele vai para o vault.
      out.push({ name: `${this.name} (.env)`, values: dotenv.map(([key, value]) => ({ key, value, type: 'secret', enabled: true })) })
    }
    return out
  }

  finish(): void {
    if (this.assertions.converted) {
      this.warn(this.name, `${this.assertions.converted} asserção(ões) do bloco assert viraram testes no script post.`)
    }
    if (this.assertions.skipped.size) {
      this.warn(this.name, `asserções e variáveis pós-resposta sem tradução ficaram de fora: ${[...this.assertions.skipped].join('; ')}.`)
    }
  }
}

/** Trocas em ordem: as formas mais longas antes das que são prefixo delas. */
const SCRIPT_RULES: [RegExp, string][] = [
  [/\bbru\.(?:setEnvVar|setVar|setGlobalEnvVar)\(/g, 'pm.environment.set('],
  [/\bbru\.(?:getEnvVar|getVar|getGlobalEnvVar|getRequestVar|getCollectionVar|getFolderVar)\(/g, 'pm.environment.get('],
  [/\bbru\.(?:deleteVar|deleteEnvVar)\(/g, 'pm.environment.unset('],
  [/\bbru\.hasVar\(/g, 'pm.environment.has('],
  [/\bbru\.interpolate\(/g, 'pm.variables.replaceIn('],
  [/\bres\.(?:getStatus\(\)|status\b)/g, 'pm.response.code'],
  [/\bres\.(?:getBody\(\)|body\b)/g, 'pm.response.json()'],
  [/\bres\.getHeader\(/g, 'pm.response.headers.get('],
  [/\bres\.(?:getResponseTime\(\)|responseTime\b)/g, 'pm.response.responseTime'],
  [/\breq\.setHeader\(/g, 'pm.request.headers.upsert('],
  [/\breq\.getHeader\(/g, 'pm.request.headers.get('],
  [/\breq\.deleteHeader\(/g, 'pm.request.headers.remove('],
  [/\breq\.(?:getUrl\(\)|url\b)/g, 'pm.request.url.toString()'],
  [/\breq\.(?:getMethod\(\)|method\b)/g, 'pm.request.method'],
  [/\breq\.(?:getBody\(\)|body\b)/g, 'pm.request.body.raw'],
  [/(?<![.\w$])test\(/g, 'pm.test('],
  [/(?<![.\w$])expect\(/g, 'pm.expect(']
]

const ASSERT_OPS: Record<string, (value: string, raw: string) => string | undefined> = {
  eq: (v) => `.to.eql(${v})`,
  neq: (v) => `.to.not.eql(${v})`,
  gt: (v) => `.to.be.above(${v})`,
  gte: (v) => `.to.be.at.least(${v})`,
  lt: (v) => `.to.be.below(${v})`,
  lte: (v) => `.to.be.at.most(${v})`,
  in: (_v, raw) => `.to.be.oneOf([${raw.split(',').map((x) => literal(x.trim())).join(', ')}])`,
  notIn: (_v, raw) => `.to.not.be.oneOf([${raw.split(',').map((x) => literal(x.trim())).join(', ')}])`,
  contains: (v) => `.to.include(${v})`,
  notContains: (v) => `.to.not.include(${v})`,
  length: (v) => `.to.have.lengthOf(${v})`,
  matches: (_v, raw) => `.to.match(new RegExp(${JSON.stringify(raw)}))`,
  notMatches: (_v, raw) => `.to.not.match(new RegExp(${JSON.stringify(raw)}))`,
  startsWith: (_v, raw) => `.to.match(new RegExp(${JSON.stringify(`^${escapeRe(unquote(raw))}`)}))`,
  endsWith: (_v, raw) => `.to.match(new RegExp(${JSON.stringify(`${escapeRe(unquote(raw))}$`)}))`,
  isNull: () => '.to.be.null',
  isUndefined: () => '.to.be.undefined',
  isDefined: () => '.to.exist',
  isTruthy: () => '.to.be.ok',
  isFalsy: () => '.to.not.be.ok',
  isJson: () => '.to.be.json',
  isNumber: () => ".to.be.a('number')",
  isString: () => ".to.be.a('string')",
  isBoolean: () => ".to.be.a('boolean')",
  isArray: () => ".to.be.an('array')",
  isEmpty: () => '.to.be.empty',
  isNotEmpty: () => '.to.not.be.empty'
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Valor de uma asserção do Bruno como literal de JavaScript: número, booleano, null, texto entre aspas ou texto solto. */
function literal(raw: string): string {
  const s = raw.trim()
  if (/^-?\d+(\.\d+)?$/.test(s) || s === 'true' || s === 'false' || s === 'null') return s
  if (/^(["']).*\1$/.test(s)) return JSON.stringify(s.slice(1, -1))
  return JSON.stringify(s)
}
