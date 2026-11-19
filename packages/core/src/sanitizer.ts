import { REQUIRED_SECRET, type Connector, type ConnectorAuth } from '@vvpost/schemas'
import type { HttpHeader, HttpRequestInput, HttpResult } from './types'
import { authHeaderName } from './connectors/headless'
import type { LoadedWorkspace } from './connectors/workspace'
import type { HttpDispatcher } from './http/dispatcher'
import { isSensitiveName, normalizeName as normalize } from './secrets'

export { isSensitiveName } from './secrets'

/** O que a IA vê no lugar de toda credencial real. */
export const REDACTED = '[REDACTED_SECRET]'

/**
 * Valores mais curtos que isto só são mascarados quando são o texto inteiro: trocar
 * toda ocorrência de "abc" no meio das respostas destruiria a saída sem proteger nada
 * que as regras por nome de campo e de header já não protejam.
 */
const MIN_SUBSTRING_LENGTH = 4
const MAX_DEPTH = 64
const MAX_TRACKED_RESPONSES = 200

/**
 * Uma referência {{VAR}} sozinha (ou depois do esquema, "Bearer {{VAR}}") é o nome
 * da variável, não o valor: pode ir para a IA, que precisa dela para editar o projeto.
 */
const WHOLE_TEMPLATE = /^\s*(?:(?:Bearer|Basic|Token|Digest)\s+)?\{\{[^{}]+\}\}\s*$/i
const TEMPLATE = /\{\{[^{}]+\}\}/g
/** Um esquema de auth sozinho, sem a credencial (pode terminar a frase com ponto). */
const SCHEME_ONLY = /^(?:Bearer|Basic|Token|Digest)[.`]?$/i
const SCHEME_VALUE = /\b([A-Za-z0-9_.-]{2,64})(\s*[:=]\s*)(Bearer|Basic|Token|Digest)(\s+)(?!\{\{|\[REDACTED_SECRET\])([^\s&;,"'}\])]+)/gi

/**
 * Credenciais com formato conhecido, mascaradas mesmo quando o VVPost nunca viu o
 * valor (ex.: um token que a API devolve no corpo de outra rota).
 */
const PATTERNS: [RegExp, string][] = [
  // Chave privada PEM inteira.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  // JWT (header e payload em base64url começam com {"  → eyJ).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Usuário e senha na URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi, `$1${REDACTED}@`],
  // Esquema de auth seguido da credencial, em qualquer texto (mensagens de erro, logs, corpos).
  // A credencial tem dígito ou símbolo: "Token expirado" é texto, não credencial; "Basic base64(...)" também.
  [/\b(Bearer|Basic|Digest|Token|Negotiate|NTLM|Bot)(\s+)(?!\[REDACTED_SECRET\])(?=[A-Za-z]*[0-9\-._~+/=])[A-Za-z0-9\-._~+/]{6,}=*(?![A-Za-z0-9\-._~+/=(])/g, `$1$2${REDACTED}`],
  // Prefixos de tokens de provedores conhecidos.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, REDACTED],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, REDACTED]
]

const KEY_CLASS = '[A-Za-z0-9_.-]'
/**
 * chave=valor e "chave": "valor" dentro de texto que não é JSON parseável (form,
 * query, corpo cortado no meio, mensagem de erro). A chave é conferida depois, por
 * isSensitiveName, para usar a mesma regra dos objetos.
 */
const KEY_VALUE = new RegExp(
  `(["']?)(${KEY_CLASS}{2,64})\\1(\\s*[:=]\\s*)(?!["']?\\[REDACTED_SECRET\\])(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)'|([^\\s&;,"'}\\])]+))`,
  'g'
)

/**
 * Valor em prosa que tem cara de credencial: uma palavra só, sem acento nem parênteses, com letra
 * e dígito (ou longa e com maiúsculas e minúsculas misturadas), e que não é um marcador como
 * `<token>`, `xxxx` ou `SUA_CHAVE`. "Authorization: Bearer seguido do token" é texto.
 */
export function looksLikeCredential(value: string): boolean {
  const v = value.trim().replace(/^[`"']+|[`"'.,;:!?)\]]+$/g, '')
  if (v.length < 6 || /\s/.test(v)) return false
  if (/^(?:x+|\.+|\*+|[A-Z_]+)$/.test(v)) return false
  if (!/^[A-Za-z0-9\-._~+/=:!@#$%^&*?]+$/.test(v)) return false
  if (/[A-Za-z]/.test(v) && /[0-9]/.test(v)) return true
  return v.length >= 20 && /[a-z]/.test(v) && /[A-Z]/.test(v)
}

export interface SanitizerOptions {
  /**
   * Texto escrito por gente (documentação): chave=valor, `Authorization: Bearer x` e linha de
   * header só são mascarados quando o valor tem cara de credencial. Valores conhecidos do
   * workspace e formatos (JWT, PEM, prefixos de provedores) seguem valendo sempre.
   */
  prose?: boolean
}

export interface SecretSanitizer {
  /** Registra um valor real de credencial (e as formas codificadas dele). */
  add(value: string | undefined): void
  /** Todo segredo do workspace: valores locais, variáveis isSecret ou de nome sensível, literais na auth. */
  addWorkspace(ws: LoadedWorkspace): void
  /** Nome extra de header ou parâmetro que carrega credencial (ex.: o inject de um login). */
  addSensitiveName(name: string): void
  /** Mascara credenciais em qualquer valor JSON, sem alterar o original. */
  sanitize<T>(value: T): T
  /** Mascara credenciais num texto. */
  text(value: string): string
  /** O texto contém algum segredo conhecido (em qualquer forma registrada)? */
  leaks(value: string): boolean
  /**
   * Dispatcher que aprende as credenciais que passam por ele: valores de headers e
   * parâmetros sensíveis das requisições e tokens devolvidos pelos fluxos de auth.
   */
  track<H extends Pick<HttpDispatcher, 'send' | 'cancel'>>(
    http: H,
    options?: { remember?: number }
  ): H & { lastResponse(id: string): HttpResult | undefined }
}

/**
 * Secret Sanitizer: a última barreira antes de qualquer dado sair para
 * um modelo de IA. Três camadas, da mais certeira para a mais genérica:
 * 1. Valores conhecidos: segredos do workspace e credenciais vistas no dispatcher,
 *    também em URL-encode, form-encode, JSON-escape e base64.
 * 2. Estrutura: valor de header, campo JSON, parâmetro ou par chave=valor cujo nome
 *    é de credencial (password, token, client_secret, Authorization, Cookie...).
 * 3. Formato: JWT, chave privada PEM, Bearer/Basic, usuário:senha na URL e tokens
 *    de provedores (AWS, GitHub, Slack, Stripe...).
 */
export function createSecretSanitizer({ prose = false }: SanitizerOptions = {}): SecretSanitizer {
  /** Formas codificadas → valor; recalculado em ordem de tamanho quando muda. */
  const forms = new Set<string>()
  const short = new Set<string>()
  const extraNames = new Set<string>()
  let ordered: string[] | null = null

  const isSensitive = (name: string) => isSensitiveName(name) || extraNames.has(normalize(name))

  function add(value: string | undefined): void {
    if (value === undefined) return
    const v = value.trim()
    if (!v || v === REQUIRED_SECRET || v === REDACTED || WHOLE_TEMPLATE.test(v)) return
    if (v.length < MIN_SUBSTRING_LENGTH) {
      short.add(v)
      return
    }
    const variants = [
      v,
      encodeURIComponent(v),
      encodeURIComponent(v).replace(/%20/g, '+'),
      JSON.stringify(v).slice(1, -1),
      Buffer.from(v).toString('base64'),
      Buffer.from(v).toString('base64').replace(/=+$/, ''),
      Buffer.from(v).toString('base64url'),
      // Hex: o valor passado por um encoder comum antes de voltar numa resposta ou num log.
      Buffer.from(v).toString('hex'),
      Buffer.from(v).toString('hex').toUpperCase()
    ]
    for (const f of variants) if (f.length >= MIN_SUBSTRING_LENGTH) forms.add(f)
    // A credencial depois do esquema ("Bearer abc" → abc) também vaza sozinha.
    const scheme = /^(?:Bearer|Basic|Token|Digest)\s+(.+)$/i.exec(v)
    if (scheme) {
      add(scheme[1])
      if (/^basic$/i.test(v.split(/\s/)[0]!)) {
        const decoded = Buffer.from(scheme[1]!, 'base64').toString('utf8')
        const sep = decoded.indexOf(':')
        if (sep > 0) add(decoded.slice(sep + 1))
      }
    }
    ordered = null
  }

  /** Literais de um texto com {{VAR}}: o que sobra fora das variáveis é valor escrito no arquivo. */
  function addLiteral(text: string | undefined): void {
    if (text === undefined) return
    for (const part of text.split(TEMPLATE)) {
      const literal = part.replace(/^\s*(?:Bearer|Basic|Token)\s*/i, '').trim()
      if (literal.length >= MIN_SUBSTRING_LENGTH) add(literal)
    }
  }

  function addAuth(auth: ConnectorAuth): void {
    switch (auth.type) {
      case 'bearer':
        addLiteral(auth.token)
        break
      case 'apiKey':
        addLiteral(auth.value)
        addSensitiveName(auth.name)
        break
      case 'basic':
        addLiteral(auth.password)
        break
      case 'oauth2':
        addLiteral(auth.clientSecret)
        addLiteral(auth.password)
        break
      case 'digest':
      case 'ntlm':
        addLiteral(auth.password)
        break
      case 'awsSigV4':
        addLiteral(auth.secretAccessKey)
        addLiteral(auth.sessionToken)
        break
      case 'oauth1':
        addLiteral(auth.consumerSecret)
        addLiteral(auth.tokenSecret)
        break
      case 'login': {
        const { request } = auth
        for (const [k, v] of Object.entries(request.form ?? {})) if (isSensitive(k)) addLiteral(v)
        collectSensitive(request.json)
        if (auth.inject?.name) addSensitiveName(auth.inject.name)
        break
      }
      case 'none':
        break
    }
    if (auth.type !== 'none') {
      const header = authHeaderName(auth)
      if (header) addSensitiveName(header)
    }
  }

  /** Valores (texto ou número) em campos de nome sensível, em qualquer profundidade. */
  function collectSensitive(value: unknown, depth = 0): void {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return
    for (const [k, v] of Object.entries(value)) {
      if ((typeof v === 'string' || typeof v === 'number') && isSensitive(k)) addLiteral(String(v))
      else collectSensitive(v, depth + 1)
    }
  }

  function addSensitiveName(name: string): void {
    if (name.trim()) extraNames.add(normalize(name))
  }

  function addWorkspace(ws: LoadedWorkspace): void {
    for (const vars of Object.values(ws.secrets)) for (const value of Object.values(vars)) add(value)
    for (const env of ws.environments.values()) {
      for (const [name, variable] of Object.entries(env.variables)) {
        if (variable.isSecret || isSensitive(name)) add(String(variable.value))
      }
    }
    for (const connector of ws.connectors.values()) addConnector(connector)
  }

  function addConnector(c: Connector): void {
    const config = c.config ?? {}
    if (config.auth) addAuth(config.auth)
    if (config.tls?.passphrase !== undefined) addLiteral(config.tls.passphrase)
    for (const [name, value] of Object.entries(config.headers ?? {})) if (isSensitive(name)) addLiteral(value)
    for (const e of c.endpoints ?? []) {
      for (const [name, value] of Object.entries(e.headers ?? {})) if (isSensitive(name)) addLiteral(value)
      for (const [name, value] of Object.entries(e.query ?? {})) if (isSensitive(name)) addLiteral(value)
    }
  }

  function replaceKnown(text: string): string {
    if (short.has(text.trim())) return REDACTED
    if (!forms.size) return text
    ordered ??= [...forms].sort((a, b) => b.length - a.length)
    let out = text
    for (const f of ordered) if (out.includes(f)) out = out.split(f).join(REDACTED)
    return out
  }

  /** Camadas 1 e 3; com `pairs`, também chave=valor e linhas de header (texto que não é JSON). */
  function text(value: string, pairs = true): string {
    let out = replaceKnown(value)
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
    if (!pairs) return out
    // "Authorization: Bearer abcdefgh": a credencial depois do esquema, mesmo só com letras.
    out = out.replace(SCHEME_VALUE, (match, key: string, sep: string, scheme: string, space: string, v: string, offset: number, whole: string) =>
      isSensitive(key) && (!prose || (looksLikeCredential(v) && whole[offset + match.length] !== '('))
        ? `${key}${sep}${scheme}${space}${REDACTED}`
        : match
    )
    out = out.replace(KEY_VALUE, (match, quote: string, key: string, sep: string, dq?: string, sq?: string, bare?: string, offset?: number, whole?: string) => {
      const v = dq ?? sq ?? bare ?? ''
      if (!isSensitive(key) || !v || WHOLE_TEMPLATE.test(v) || (bare !== undefined && /^(?:true|false|null)$/.test(v))) return match
      // Em prosa, o esquema sozinho é texto e a credencial depois dele passa pelas regras de formato.
      if (prose && (SCHEME_ONLY.test(v) || !looksLikeCredential(v))) return match
      // Só o esquema ("Authorization: Bearer {{$token}}", "em Authorization: Basic;"): a credencial,
      // se houver, vem depois e as regras de formato cuidam dela.
      if (bare !== undefined && SCHEME_ONLY.test(v)) {
        const rest = (whole ?? '').slice((offset ?? 0) + match.length)
        // Ponto ou crase depois do esquema fecham a frase ou o trecho de código.
        if (/[.`]$/.test(v) || /^(?:\s+\{\{[^{}]+\}\}|\s*(?:$|[;,)\]}\n]))/.test(rest)) return match
      }
      const q = dq !== undefined ? '"' : sq !== undefined ? "'" : ''
      return `${quote}${key}${quote}${sep}${q}${REDACTED}${q}`
    })
    // Header cru numa linha de texto ("Authorization: abc", "Cookie: a=b; c=d").
    out = out.replace(/^([A-Za-z0-9-]{2,64})(:[ \t]*)(.+)$/gm, (match, name: string, sep: string, v: string) =>
      isSensitive(name) && v.trim() !== REDACTED && !WHOLE_TEMPLATE.test(v) && (!prose || proseHeaderValue(v)) ? `${name}${sep}${REDACTED}` : match
    )
    return out
  }

  /** Valor de uma linha de header em prosa: o que vem depois do esquema tem cara de credencial. */
  function proseHeaderValue(v: string): boolean {
    const rest = v.trim().replace(/^(?:Bearer|Basic|Token|Digest)\s+/i, '')
    return !rest.includes(REDACTED) && rest.split(/[\s;,]+/).some((part) => looksLikeCredential(part.replace(/^[^=]*=/, '')))
  }

  /** Texto que é JSON vira objeto, é sanitizado pela estrutura e volta ao mesmo formato. */
  function sanitizeString(value: string, depth: number): string {
    const trimmed = value.trim()
    if (trimmed.length >= 2 && (trimmed[0] === '{' || trimmed[0] === '[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        const indent = /^[{[]\s*\n(\s+)/.exec(trimmed)?.[1]?.length ?? 0
        // A estrutura já foi tratada campo a campo; o texto final só passa pelos valores e formatos.
        return text(JSON.stringify(walk(parsed, depth + 1), null, indent || undefined), false)
      } catch {
        // não é JSON inteiro (ex.: corpo cortado): cai nas regras de texto
      }
    }
    if (/^[^\s=&]+=[^\s&]*(?:&[^\s=&]+=[^\s&]*)*$/.test(trimmed) && trimmed.includes('=')) {
      try {
        const form = new URLSearchParams(trimmed)
        let changed = false
        for (const [k, v] of [...form]) {
          if (isSensitive(k) && v && v !== REDACTED && !WHOLE_TEMPLATE.test(v) && (!prose || looksLikeCredential(v))) {
            form.set(k, REDACTED)
            changed = true
          }
        }
        if (changed) return text(form.toString().replace(/%5BREDACTED_SECRET%5D/g, REDACTED))
      } catch {
        // segue para o texto
      }
    }
    return text(value)
  }

  function walk(value: unknown, depth: number, key?: string): unknown {
    if (depth > MAX_DEPTH) return REDACTED
    if (typeof value === 'string') {
      if (key !== undefined && isSensitive(key) && value && !WHOLE_TEMPLATE.test(value)) return REDACTED
      return sanitizeString(value, depth)
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      if (key !== undefined && isSensitive(key)) return REDACTED
      return short.has(String(value)) || (String(value).length >= MIN_SUBSTRING_LENGTH && forms.has(String(value)))
        ? REDACTED
        : value
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1))
    if (value && typeof value === 'object') {
      const entries = Object.entries(value)
      // { name, value } é um header (ou parâmetro): o nome decide se o valor é credencial.
      const header = value as Partial<HttpHeader>
      const headerLike =
        typeof header.name === 'string' && 'value' in header && entries.every(([k]) => ['name', 'value', 'from', 'overrides', 'enabled'].includes(k))
      return Object.fromEntries(
        entries.map(([k, v]) => {
          const cleanKey = text(k)
          if (headerLike && k === 'value' && isSensitive(header.name!)) {
            return [k, typeof v === 'string' && WHOLE_TEMPLATE.test(v) ? v : v === '' || v == null ? v : REDACTED]
          }
          return [cleanKey, walk(v, depth + 1, k)]
        })
      )
    }
    return value
  }

  /** `remember`: respostas guardadas para `lastResponse` (0 quando ninguém consulta, como no app). */
  function track<H extends Pick<HttpDispatcher, 'send' | 'cancel'>>(http: H, { remember = MAX_TRACKED_RESPONSES } = {}) {
    const last = new Map<string, HttpResult>()
    const learnRequest = (input: HttpRequestInput) => {
      for (const h of input.headers) if (isSensitive(h.name)) add(h.value)
      try {
        for (const [k, v] of new URL(input.url).searchParams) if (isSensitive(k)) add(v)
        const { username, password } = new URL(input.url)
        add(password && decodeURIComponent(password))
        if (password) add(decodeURIComponent(username))
      } catch {
        // URL inválida: o dispatcher devolve o erro
      }
      if (input.id.startsWith('auth:') && input.body) {
        try {
          collectSensitive(JSON.parse(input.body))
        } catch {
          for (const [k, v] of new URLSearchParams(input.body)) if (isSensitive(k)) add(v)
        }
      }
    }
    const learnAuthResponse = (result: HttpResult) => {
      if (!result.ok) return
      try {
        collectSensitive(JSON.parse(result.response.body))
      } catch {
        // login que devolve o token em texto puro: o token aparece depois no header injetado
      }
      for (const h of result.response.headers) if (isSensitive(h.name)) add(h.value)
    }
    const wrapped = Object.create(http) as H & { lastResponse(id: string): HttpResult | undefined }
    wrapped.send = async (input: HttpRequestInput, options?: Parameters<HttpDispatcher['send']>[1]) => {
      learnRequest(input)
      const result = await http.send(input, options)
      if (input.id.startsWith('auth:')) learnAuthResponse(result)
      else {
        if (remember > 0) last.set(input.id, result)
        // Só o lote em andamento precisa disto: as respostas mais antigas saem.
        if (last.size > remember) last.delete(last.keys().next().value!)
        // Cookies de sessão devolvidos pela API também são credenciais.
        if (result.ok) for (const h of result.response.headers) if (/^set-cookie$/i.test(h.name)) addCookie(h.value)
      }
      return result
    }
    wrapped.cancel = (id: string) => http.cancel(id)
    wrapped.lastResponse = (id: string) => last.get(id)
    return wrapped
  }

  function addCookie(header: string): void {
    const pair = header.split(';')[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq > 0) add(pair.slice(eq + 1))
  }

  return {
    add,
    addWorkspace,
    addSensitiveName,
    sanitize: <T>(value: T) => walk(value, 0) as T,
    text: (value: string) => sanitizeString(value, 0),
    leaks(value: string): boolean {
      return replaceKnown(value) !== value
    },
    track
  }
}
