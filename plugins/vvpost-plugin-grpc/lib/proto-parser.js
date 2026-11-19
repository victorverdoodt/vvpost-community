// @ts-check
'use strict'

/**
 * Parser de arquivos .proto (proto2, proto3 e edições, no que importa para chamar um
 * serviço): pacote, mensagens com campos, map, oneof, mensagens e enums aninhados, enums
 * e serviços. Opções, reserved, extensions e extend são lidos e ignorados (só packed e
 * json_name contam). Um texto pode trazer vários arquivos em sequência: cada `syntax` ou
 * `edition` começa um arquivo novo (e zera o pacote).
 *
 * Devolve descrições "cruas" (nomes de tipo como escritos); a resolução fica no Registry.
 */

class ProtoSyntaxError extends Error {
  /** @param {string} message @param {number} line */
  constructor(message, line) {
    super(`.proto, linha ${line}: ${message}`)
    this.code = 'PROTO_SYNTAX'
  }
}

/** @typedef {{ kind: 'ident' | 'number' | 'string' | 'symbol', value: string, line: number }} Token */

/** @param {string} text @returns {Token[]} */
function tokenize(text) {
  /** @type {Token[]} */
  const tokens = []
  let i = 0
  let line = 1
  while (i < text.length) {
    const c = text.charAt(i)
    if (c === '\n') {
      line++
      i++
    } else if (/\s/.test(c)) i++
    else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      for (let j = i; j < stop; j++) if (text[j] === '\n') line++
      i = stop
    } else if (c === '"' || c === "'") {
      let j = i + 1
      let value = ''
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') {
          const n = text[j + 1]
          value += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
          j += 2
        } else value += text[j++]
      }
      if (j >= text.length) throw new ProtoSyntaxError('texto sem aspas de fechamento', line)
      tokens.push({ kind: 'string', value, line })
      i = j + 1
    } else if (/[A-Za-z_.]/.test(c) && !(c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i
      while (j < text.length && /[A-Za-z0-9_.]/.test(text.charAt(j))) j++
      tokens.push({ kind: 'ident', value: text.slice(i, j), line })
      i = j
    } else if (/[0-9.\-+]/.test(c)) {
      let j = i + 1
      while (j < text.length && /[0-9A-Za-z_.+-]/.test(text.charAt(j)) && !(/[+-]/.test(text.charAt(j)) && !/[eE]/.test(text.charAt(j - 1)))) j++
      tokens.push({ kind: 'number', value: text.slice(i, j), line })
      i = j
    } else {
      tokens.push({ kind: 'symbol', value: c, line })
      i++
    }
  }
  return tokens
}

/**
 * @typedef {{ name: string, number: number, label: 'optional' | 'repeated' | 'required' | undefined,
 *   typeName: string, mapKey?: string, oneof?: string, packed?: boolean, jsonName?: string, proto3Optional?: boolean }} RawField
 * @typedef {{ kind: 'message', name: string, fields: RawField[], nested: RawType[] }} RawMessage
 * @typedef {{ kind: 'enum', name: string, values: [string, number][] }} RawEnum
 * @typedef {RawMessage | RawEnum} RawType
 * @typedef {{ name: string, input: string, output: string, clientStreaming: boolean, serverStreaming: boolean }} RawMethod
 * @typedef {{ name: string, methods: RawMethod[] }} RawService
 * @typedef {{ name: string, syntax: string, package: string, imports: string[], types: RawType[], services: RawService[] }} RawFile
 */

/** @param {string} text @param {string} [name] @returns {RawFile[]} */
function parseProto(text, name = 'input.proto') {
  const tokens = tokenize(text)
  let pos = 0
  /** @type {RawFile[]} */
  const files = []
  /** @type {RawFile} */
  let file = { name, syntax: 'proto2', package: '', imports: [], types: [], services: [] }
  let started = false

  // No fim, um token vazio: quem o consome com next() recebe o erro de fim de arquivo.
  /** @returns {Token} */
  const peek = () => tokens[pos] ?? { kind: 'symbol', value: '', line: lineNow() }
  const lineNow = () => (tokens[pos] ?? tokens[tokens.length - 1] ?? { line: 1 }).line
  const next = () => {
    const t = tokens[pos++]
    if (!t) throw new ProtoSyntaxError('fim inesperado do arquivo', lineNow())
    return t
  }
  /** @param {string} value */
  const expect = (value) => {
    const t = next()
    if (t.value !== value) throw new ProtoSyntaxError(`esperava "${value}", veio "${t.value}"`, t.line)
    return t
  }
  /** @param {string} value */
  const accept = (value) => {
    if (peek()?.value === value && peek()?.kind !== 'string') {
      pos++
      return true
    }
    return false
  }
  const ident = () => {
    const t = next()
    if (t.kind !== 'ident') throw new ProtoSyntaxError(`esperava um nome, veio "${t.value}"`, t.line)
    return t.value
  }
  const integer = () => {
    const t = next()
    const n = Number(t.value.startsWith('0') && /^0[0-7]+$/.test(t.value) ? parseInt(t.value, 8) : t.value)
    if (t.kind !== 'number' || !Number.isInteger(n)) throw new ProtoSyntaxError(`esperava um número inteiro, veio "${t.value}"`, t.line)
    return n
  }
  // Pula até o ";" do nível atual, atravessando blocos { } (opções agregadas).
  const skipStatement = () => {
    let depth = 0
    for (;;) {
      const t = next()
      if (t.kind === 'symbol') {
        if (t.value === '{') depth++
        else if (t.value === '}') {
          depth--
          if (depth === 0 && peek()?.value !== ';') return
        } else if (t.value === ';' && depth === 0) return
      }
    }
  }
  const skipBlock = () => {
    while (peek() && peek().value !== '{') next()
    expect('{')
    let depth = 1
    while (depth > 0) {
      const t = next()
      if (t.kind === 'symbol' && t.value === '{') depth++
      else if (t.kind === 'symbol' && t.value === '}') depth--
    }
    accept(';')
  }
  /** Lê [a = b, c = d] de um campo: só packed e json_name importam. */
  const fieldOptions = () => {
    /** @type {{ packed?: boolean, jsonName?: string }} */
    const out = {}
    if (!accept('[')) return out
    for (;;) {
      let key = ''
      if (accept('(')) {
        key = '(' + ident() + ')'
        expect(')')
        if (peek()?.kind === 'ident' && peek().value.startsWith('.')) key += next().value
      } else key = ident()
      expect('=')
      let value = ''
      if (peek()?.value === '{') {
        let depth = 0
        do {
          const t = next()
          if (t.value === '{') depth++
          else if (t.value === '}') depth--
        } while (depth > 0)
      } else value = next().value
      if (key === 'packed') out.packed = value === 'true'
      if (key === 'json_name') out.jsonName = value
      if (key === 'features.repeated_field_encoding') out.packed = value === 'PACKED'
      if (accept(']')) return out
      expect(',')
    }
  }
  /** @param {string} prefix */
  const enumBody = (prefix) => {
    /** @type {RawEnum} */
    const e = { kind: 'enum', name: prefix, values: [] }
    expect('{')
    while (!accept('}')) {
      if (accept(';')) continue
      const t = peek()
      if (t.value === 'option' || t.value === 'reserved') {
        skipStatement()
        continue
      }
      const name = ident()
      expect('=')
      const negative = accept('-')
      const n = integer()
      fieldOptions()
      expect(';')
      e.values.push([name, negative ? -n : n])
    }
    return e
  }
  /** @param {string} name @returns {RawMessage} */
  const messageBody = (name) => {
    /** @type {RawMessage} */
    const m = { kind: 'message', name, fields: [], nested: [] }
    expect('{')
    /** @param {string | undefined} oneof */
    const field = (oneof) => {
      const t = peek()
      /** @type {RawField['label']} */
      let label
      if (t.value === 'optional' || t.value === 'repeated' || t.value === 'required') {
        label = /** @type {RawField['label']} */ (next().value)
      }
      if (peek().value === 'group') throw new ProtoSyntaxError('groups do proto2 não são suportados', peek().line)
      let typeName
      let mapKey
      if (peek().value === 'map' && tokens[pos + 1]?.value === '<') {
        next()
        expect('<')
        mapKey = ident()
        expect(',')
        typeName = ident()
        expect('>')
      } else typeName = ident()
      const fieldName = ident()
      expect('=')
      const number = integer()
      const opts = fieldOptions()
      expect(';')
      m.fields.push({
        name: fieldName,
        number,
        label: mapKey ? 'repeated' : label,
        typeName,
        ...(mapKey && { mapKey }),
        ...(oneof && { oneof }),
        ...(opts.packed !== undefined && { packed: opts.packed }),
        ...(opts.jsonName && { jsonName: opts.jsonName }),
        ...(label === 'optional' && file.syntax === 'proto3' && { proto3Optional: true })
      })
    }
    while (!accept('}')) {
      if (accept(';')) continue
      const t = peek()
      switch (t.value) {
        case 'message':
          next()
          m.nested.push(messageBody(ident()))
          break
        case 'enum':
          next()
          m.nested.push(enumBody(ident()))
          break
        case 'option':
        case 'reserved':
        case 'extensions':
          skipStatement()
          break
        case 'extend':
          skipBlock()
          break
        case 'oneof': {
          next()
          const oneof = ident()
          expect('{')
          while (!accept('}')) {
            if (accept(';')) continue
            if (peek().value === 'option') skipStatement()
            else field(oneof)
          }
          break
        }
        default:
          field(undefined)
      }
    }
    return m
  }
  const serviceBody = () => {
    /** @type {RawService} */
    const s = { name: ident(), methods: [] }
    expect('{')
    while (!accept('}')) {
      if (accept(';')) continue
      if (peek().value === 'option') {
        skipStatement()
        continue
      }
      expect('rpc')
      const name = ident()
      expect('(')
      const clientStreaming = peek().value === 'stream' && tokens[pos + 1]?.value !== ')' ? (next(), true) : false
      const input = ident()
      expect(')')
      expect('returns')
      expect('(')
      const serverStreaming = peek().value === 'stream' && tokens[pos + 1]?.value !== ')' ? (next(), true) : false
      const output = ident()
      expect(')')
      if (peek()?.value === '{') skipBlock()
      else expect(';')
      s.methods.push({ name, input, output, clientStreaming, serverStreaming })
    }
    return s
  }

  while (pos < tokens.length) {
    const t = next()
    if (t.kind === 'symbol' && t.value === ';') continue
    switch (t.value) {
      case 'syntax':
      case 'edition': {
        if (started) {
          files.push(file)
          file = { name: `${name}#${files.length + 1}`, syntax: 'proto2', package: '', imports: [], types: [], services: [] }
        }
        expect('=')
        const v = next().value
        file.syntax = t.value === 'edition' ? 'editions' : v
        expect(';')
        break
      }
      case 'package':
        file.package = ident()
        expect(';')
        break
      case 'import':
        if (peek()?.value === 'public' || peek()?.value === 'weak') next()
        file.imports.push(next().value)
        expect(';')
        break
      case 'option':
        pos--
        skipStatement()
        break
      case 'message':
        file.types.push(messageBody(ident()))
        break
      case 'enum':
        file.types.push(enumBody(ident()))
        break
      case 'service':
        file.services.push(serviceBody())
        break
      case 'extend':
        pos--
        skipBlock()
        break
      default:
        throw new ProtoSyntaxError(`não esperava "${t.value}"`, t.line)
    }
    started = true
  }
  files.push(file)
  return files
}

module.exports = { parseProto, tokenize, ProtoSyntaxError }
