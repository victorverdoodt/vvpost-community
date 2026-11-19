/**
 * Requisição como código (menus "Copiar como cURL" e "Copiar como código") e o caminho
 * contrário, "Colar cURL". Só texto: os headers herdados e a auth do conector não entram,
 * porque o segredo nunca chega ao renderer; `{{VAR}}` vai como está.
 */
import type { PayloadFormField, RequestPayload } from '@shared/ipc'

export interface RequestSnapshot {
  method: string
  url: string
  headers: { name: string; value: string }[]
  body?: string
  /** Corpo estruturado (form, multipart, binário), no lugar de body. */
  payload?: RequestPayload
}

export type CodeTarget = 'curl' | 'fetch' | 'python' | 'httpie'

export const CODE_TARGET_LABEL: Record<CodeTarget, string> = {
  curl: 'cURL',
  fetch: 'JavaScript (fetch)',
  python: 'Python (requests)',
  httpie: 'HTTPie'
}

/** Aspas simples de shell POSIX: 'it'\''s'. */
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function toCode(target: CodeTarget, req: RequestSnapshot): string {
  const method = req.method.toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const payload = hasBody ? req.payload : undefined
  const body = !payload && req.body && hasBody ? req.body : undefined
  const fields: PayloadFormField[] = payload && payload.mode !== 'binary' ? payload.fields : []
  switch (target) {
    case 'curl': {
      const parts = [`curl${method === 'GET' && !body && !payload ? '' : ` -X ${method}`} ${sh(req.url)}`]
      for (const h of req.headers) parts.push(`-H ${sh(`${h.name}: ${h.value}`)}`)
      if (body) parts.push(`--data-raw ${sh(body)}`)
      if (payload?.mode === 'binary') parts.push(`--data-binary ${sh(`@${payload.file}`)}`)
      for (const f of fields) {
        if (payload?.mode === 'urlencoded') parts.push(`--data-urlencode ${sh(`${f.name}=${f.value ?? ''}`)}`)
        else if (f.file !== undefined) parts.push(`-F ${sh(`${f.name}=@${f.file}${f.contentType ? `;type=${f.contentType}` : ''}`)}`)
        else parts.push(`-F ${sh(`${f.name}=${f.value ?? ''}`)}`)
      }
      return parts.join(' \\\n  ')
    }
    case 'httpie': {
      const parts = [`http${payload && payload.mode !== 'binary' ? (payload.mode === 'multipart' ? ' --multipart' : ' --form') : ''} ${method} ${sh(req.url)}`]
      for (const h of req.headers) parts.push(sh(`${h.name}:${h.value}`))
      for (const f of fields) parts.push(sh(f.file !== undefined ? `${f.name}@${f.file}` : `${f.name}=${f.value ?? ''}`))
      if (payload?.mode === 'binary') return `${parts.join(' ')} < ${sh(payload.file)}`
      return body ? `printf '%s' ${sh(body)} | ${parts.join(' ')}` : parts.join(' ')
    }
    case 'fetch': {
      const pre: string[] = []
      const init: string[] = [`  method: ${JSON.stringify(method)}`]
      if (req.headers.length) {
        const lines = req.headers.map((h) => `    ${JSON.stringify(h.name)}: ${JSON.stringify(h.value)}`)
        init.push(`  headers: {\n${lines.join(',\n')}\n  }`)
      }
      if (body) init.push(`  body: ${JSON.stringify(body)}`)
      if (payload?.mode === 'binary') {
        pre.push(`import { readFile } from 'node:fs/promises'`, '')
        init.push(`  body: await readFile(${JSON.stringify(payload.file)})`)
      } else if (payload) {
        const urlencoded = payload.mode === 'urlencoded'
        if (!urlencoded && fields.some((f) => f.file !== undefined)) pre.push(`import { openAsBlob } from 'node:fs'`, '')
        pre.push(`const body = new ${urlencoded ? 'URLSearchParams' : 'FormData'}()`)
        for (const f of fields) {
          pre.push(
            f.file !== undefined
              ? `body.append(${JSON.stringify(f.name)}, await openAsBlob(${JSON.stringify(f.file)}), ${JSON.stringify(f.file.split(/[\\/]/).pop())})`
              : `body.append(${JSON.stringify(f.name)}, ${JSON.stringify(f.value ?? '')})`
          )
        }
        pre.push('')
        init.push('  body')
      }
      return `${pre.join('\n')}${pre.length ? '\n' : ''}const response = await fetch(${JSON.stringify(req.url)}, {\n${init.join(',\n')}\n})\nconsole.log(response.status, await response.text())`
    }
    case 'python': {
      const lines = ['import requests', '']
      const args = [JSON.stringify(method), JSON.stringify(req.url)]
      if (req.headers.length) {
        lines.push('headers = {')
        for (const h of req.headers) lines.push(`    ${JSON.stringify(h.name)}: ${JSON.stringify(h.value)},`)
        lines.push('}')
        args.push('headers=headers')
      }
      if (body) {
        lines.push(`data = ${JSON.stringify(body)}`)
        args.push('data=data.encode("utf-8")')
      }
      if (payload?.mode === 'binary') {
        lines.push(`data = open(${JSON.stringify(payload.file)}, "rb")`)
        args.push('data=data')
      } else if (payload) {
        const text = fields.filter((f) => !(f.file !== undefined))
        const files = fields.filter((f) => f.file !== undefined)
        lines.push('data = {')
        for (const f of text) lines.push(`    ${JSON.stringify(f.name)}: ${JSON.stringify(f.value ?? '')},`)
        lines.push('}')
        args.push('data=data')
        if (files.length) {
          lines.push('files = {')
          for (const f of files) lines.push(`    ${JSON.stringify(f.name)}: open(${JSON.stringify(f.file)}, "rb"),`)
          lines.push('}')
          args.push('files=files')
        }
      }
      lines.push(`response = requests.request(${args.join(', ')})`, 'print(response.status_code, response.text)')
      return lines.join('\n')
    }
  }
}

/** Quebra uma linha de shell em palavras (aspas simples, duplas, barra e continuação de linha). */
function shellWords(input: string): string[] {
  const words: string[] = []
  let word = ''
  let has = false
  let i = 0
  const text = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ')
  while (i < text.length) {
    const c = text[i]!
    if (/\s/.test(c)) {
      if (has) words.push(word)
      word = ''
      has = false
      i++
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      word += text.slice(i + 1, end < 0 ? undefined : end)
      has = true
      i = end < 0 ? text.length : end + 1
    } else if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1]!)) i++
        word += text[i]
        i++
      }
      has = true
      i++
    } else if (c === '$' && text[i + 1] === "'") {
      // $'...' do bash: \n, \t, \' e \\.
      i += 2
      while (i < text.length && text[i] !== "'") {
        if (text[i] === '\\' && i + 1 < text.length) {
          const n = text[++i]!
          word += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
        } else word += text[i]
        i++
      }
      has = true
      i++
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[i + 1]
      has = true
      i += 2
    } else {
      word += c
      has = true
      i++
    }
  }
  if (has) words.push(word)
  return words
}

const DATA_FLAGS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json'])
/** Flags do curl que levam um valor e não mudam a requisição para o VVPost. */
const VALUE_FLAGS = new Set([
  '-o', '--output', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '--retry',
  '-x', '--proxy', '-e', '--referer', '--cacert', '--cert', '--key', '-E', '-r', '--range'
])

/** Lê um comando curl (copiado do navegador, de um README, do próprio VVPost). null se não for curl. */
export function parseCurl(input: string): RequestSnapshot | null {
  const words = shellWords(input.trim())
  if (words[0] !== 'curl' && words[0] !== 'curl.exe') return null
  let method: string | null = null
  let url = ''
  const headers: { name: string; value: string }[] = []
  const data: string[] = []
  const form: { name: string; value?: string; file?: string; contentType?: string }[] = []
  const urlencoded: { name: string; value: string }[] = []
  let json = false
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    const next = () => words[++i] ?? ''
    if (w === '-X' || w === '--request') method = next().toUpperCase()
    else if (w.startsWith('-X') && w.length > 2) method = w.slice(2).toUpperCase()
    else if (w === '-H' || w === '--header') {
      const h = next()
      const at = h.indexOf(':')
      if (at > 0) headers.push({ name: h.slice(0, at).trim(), value: h.slice(at + 1).trim() })
    } else if (DATA_FLAGS.has(w)) {
      if (w === '--json') json = true
      data.push(next())
    } else if (w === '-F' || w === '--form') {
      const f = next()
      const at = f.indexOf('=')
      if (at > 0) {
        const name = f.slice(0, at)
        const [value = '', ...attrs] = f.slice(at + 1).split(';')
        const type = attrs.find((a) => a.startsWith('type='))?.slice(5)
        form.push(value.startsWith('@') ? { name, file: value.slice(1), ...(type && { contentType: type }) } : { name, value })
      }
    } else if (w === '--data-urlencode') {
      const f = next()
      const at = f.indexOf('=')
      urlencoded.push(at < 0 ? { name: f, value: '' } : { name: f.slice(0, at), value: f.slice(at + 1) })
    } else if (w === '-u' || w === '--user') {
      headers.push({ name: 'Authorization', value: `Basic ${btoa(next())}` })
    } else if (w === '-A' || w === '--user-agent') headers.push({ name: 'User-Agent', value: next() })
    else if (w === '-b' || w === '--cookie') headers.push({ name: 'Cookie', value: next() })
    else if (w === '-I' || w === '--head') method = 'HEAD'
    else if (w === '--url') url = next()
    else if (VALUE_FLAGS.has(w)) next()
    else if (!w.startsWith('-') && !url) url = w
  }
  if (!url) return null
  const binary = data.length === 1 && data[0]!.startsWith('@') ? data[0]!.slice(1) : undefined
  const payload: RequestPayload | undefined = form.length
    ? { mode: 'multipart', fields: form }
    : urlencoded.length && !data.length
      ? { mode: 'urlencoded', fields: urlencoded }
      : binary
        ? { mode: 'binary', file: binary }
        : undefined
  if (payload) return { method: method ?? 'POST', url, headers, payload }
  const body = data.length || urlencoded.length ? [...data, ...urlencoded.map((f) => `${encodeURIComponent(f.name)}=${encodeURIComponent(f.value)}`)].join('&') : undefined
  if (json && !headers.some((h) => h.name.toLowerCase() === 'content-type')) {
    headers.push({ name: 'Content-Type', value: 'application/json' })
  }
  return { method: method ?? (body ? 'POST' : 'GET'), url, headers, ...(body !== undefined && { body }) }
}
