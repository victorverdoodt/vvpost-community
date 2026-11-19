import { validateJsonSchema } from '@vvpost/schemas'
import type { JsonPathSegment } from './jsonpath'

/**
 * As funções do `then` das regras: as nativas do Spectral (mesmo nome, mesmas opções) e as do
 * VVPost. Cada uma recebe o valor alvo e devolve os achados; nenhuma lança.
 */

export interface LintFunctionResult {
  message: string
  /** Caminho relativo ao alvo, quando o achado é mais fundo que ele. */
  path?: JsonPathSegment[]
  /** Como corrigir este achado, no lugar do hint da regra. */
  hint?: string
}

export interface LintFunctionContext {
  /** Caminho do alvo no documento. */
  path: JsonPathSegment[]
  document: unknown
}

export interface LintFunction {
  /** Problema nas opções, conferido uma vez ao montar o ruleset. */
  checkOptions?(options: unknown): string | undefined
  run(input: unknown, options: Record<string, unknown>, ctx: LintFunctionContext): LintFunctionResult[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** "/re/flags" ou "re", como o Spectral aceita no pattern. */
export function toRegExp(text: string): RegExp {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(text)
  return m ? new RegExp(m[1]!, m[2]!.replace('g', '')) : new RegExp(text)
}

const CASES: Record<string, { re: string; digits: string; label: string }> = {
  flat: { re: '[a-z][a-z{d}]*', digits: '0-9', label: 'flat case (minúsculas juntas)' },
  camel: { re: '[a-z][a-z{d}]*(?:[A-Z{d}](?:[a-z{d}]+|$))*', digits: '0-9', label: 'camelCase' },
  pascal: { re: '[A-Z][a-z{d}]*(?:[A-Z{d}](?:[a-z{d}]+|$))*', digits: '0-9', label: 'PascalCase' },
  kebab: { re: '[a-z][a-z{d}]*(?:-[a-z{d}]+)*', digits: '0-9', label: 'kebab-case' },
  cobol: { re: '[A-Z][A-Z{d}]*(?:-[A-Z{d}]+)*', digits: '0-9', label: 'COBOL-CASE' },
  snake: { re: '[a-z][a-z{d}]*(?:_[a-z{d}]+)*', digits: '0-9', label: 'snake_case' },
  macro: { re: '[A-Z][A-Z{d}]*(?:_[A-Z{d}]+)*', digits: '0-9', label: 'MACRO_CASE' }
}

function casingRegExp(options: Record<string, unknown>): RegExp {
  const c = CASES[options['type'] as string]!
  const body = c.re.replaceAll('{d}', options['disallowDigits'] ? '' : c.digits)
  const sep = isObject(options['separator']) ? options['separator'] : undefined
  if (!sep) return new RegExp(`^${body}$`)
  const ch = String(sep['char']).replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
  const leading = sep['allowLeading'] ? `(?:${ch})?` : ''
  return new RegExp(`^${leading}${body}(?:${ch}${body})*$`)
}

const OAS_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])

/** Os parâmetros in: path de uma lista, pelo nome (com o índice na lista); $ref fica de fora. */
function pathParams(list: unknown): Map<string, { index: number; required: unknown }> {
  const out = new Map<string, { index: number; required: unknown }>()
  if (!Array.isArray(list)) return out
  for (const [index, p] of list.entries()) {
    if (isObject(p) && p['in'] === 'path' && typeof p['name'] === 'string') out.set(p['name'], { index, required: p['required'] })
  }
  return out
}

const describe = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v))

export const LINT_FUNCTIONS: Record<string, LintFunction> = {
  truthy: {
    run: (v) => (v ? [] : [{ message: 'precisa estar preenchido' }])
  },
  falsy: {
    run: (v) => (v ? [{ message: 'não deveria estar preenchido' }] : [])
  },
  defined: {
    run: (v) => (v === undefined ? [{ message: 'precisa estar definido' }] : [])
  },
  undefined: {
    run: (v) => (v === undefined ? [] : [{ message: 'não deveria estar definido' }])
  },
  pattern: {
    checkOptions(o) {
      if (!isObject(o) || (o['match'] === undefined && o['notMatch'] === undefined)) return 'pattern precisa de match ou notMatch'
      for (const key of ['match', 'notMatch']) {
        if (o[key] === undefined) continue
        if (typeof o[key] !== 'string') return `pattern: ${key} precisa ser texto`
        try {
          toRegExp(o[key] as string)
        } catch (err) {
          return `pattern: ${key} inválido (${(err as Error).message})`
        }
      }
      return undefined
    },
    run(v, o) {
      if (typeof v !== 'string') return []
      const out: LintFunctionResult[] = []
      if (typeof o['match'] === 'string' && !toRegExp(o['match']).test(v)) out.push({ message: `${describe(v)} não segue o padrão ${o['match']}` })
      if (typeof o['notMatch'] === 'string' && toRegExp(o['notMatch']).test(v)) out.push({ message: `${describe(v)} não pode seguir o padrão ${o['notMatch']}` })
      return out
    }
  },
  casing: {
    checkOptions: (o) => (isObject(o) && typeof o['type'] === 'string' && CASES[o['type']] ? undefined : `casing: type precisa ser ${Object.keys(CASES).join(', ')}`),
    run(v, o) {
      if (typeof v !== 'string' || v.length === 0) return []
      return casingRegExp(o).test(v) ? [] : [{ message: `${describe(v)} não está em ${CASES[o['type'] as string]!.label}` }]
    }
  },
  enumeration: {
    checkOptions: (o) => (isObject(o) && Array.isArray(o['values']) ? undefined : 'enumeration precisa de values (lista)'),
    run(v, o) {
      if (v === undefined || (typeof v === 'object' && v !== null)) return []
      const values = o['values'] as unknown[]
      return values.includes(v) ? [] : [{ message: `${describe(v)} não é um de ${values.map(describe).join(', ')}` }]
    }
  },
  length: {
    checkOptions: (o) => (isObject(o) && (typeof o['min'] === 'number' || typeof o['max'] === 'number') ? undefined : 'length precisa de min ou max'),
    run(v, o) {
      let n: number
      if (typeof v === 'string' || Array.isArray(v)) n = v.length
      else if (isObject(v)) n = Object.keys(v).length
      else if (typeof v === 'number') n = v
      else return []
      const min = o['min'] as number | undefined
      const max = o['max'] as number | undefined
      if (min !== undefined && n < min) return [{ message: `tem ${n} e o mínimo é ${min}` }]
      if (max !== undefined && n > max) return [{ message: `tem ${n} e o máximo é ${max}` }]
      return []
    }
  },
  schema: {
    checkOptions: (o) => (isObject(o) && isObject(o['schema']) ? undefined : 'schema precisa de schema (objeto JSON Schema)'),
    run(v, o) {
      if (v === undefined) return []
      const result = validateJsonSchema(o['schema'] as object, v)
      if (result.ok) return []
      const issues = o['allErrors'] ? result.issues : result.issues.slice(0, 1)
      return issues.map((i) => ({
        message: `${i.path || '/'} ${i.message}`.trim(),
        ...(i.path && { path: i.path.split('/').filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p.replace(/~1/g, '/').replace(/~0/g, '~'))) })
      }))
    }
  },
  alphabetical: {
    run(v, o) {
      const keyedBy = typeof o['keyedBy'] === 'string' ? o['keyedBy'] : undefined
      const keys: unknown[] = Array.isArray(v) ? (keyedBy ? v.map((item) => (isObject(item) ? item[keyedBy] : undefined)) : v) : isObject(v) ? Object.keys(v) : []
      for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1]
        const b = keys[i]
        if ((typeof a === 'string' || typeof a === 'number') && (typeof b === 'string' || typeof b === 'number') && String(a).localeCompare(String(b)) > 0) {
          return [{ message: `fora da ordem alfabética: ${describe(b)} deveria vir antes de ${describe(a)}` }]
        }
      }
      return []
    }
  },
  xor: {
    checkOptions: (o) => (isObject(o) && Array.isArray(o['properties']) && o['properties'].length >= 2 ? undefined : 'xor precisa de properties (lista com dois ou mais)'),
    run(v, o) {
      if (!isObject(v)) return []
      const props = o['properties'] as string[]
      const present = props.filter((p) => v[p] !== undefined)
      return present.length === 1 ? [] : [{ message: `precisa de exatamente um entre ${props.join(', ')}` }]
    }
  },
  or: {
    checkOptions: (o) => (isObject(o) && Array.isArray(o['properties']) && o['properties'].length >= 1 ? undefined : 'or precisa de properties (lista)'),
    run(v, o) {
      if (!isObject(v)) return []
      const props = o['properties'] as string[]
      return props.some((p) => v[p] !== undefined) ? [] : [{ message: `precisa de pelo menos um entre ${props.join(', ')}` }]
    }
  },
  // --- Do VVPost ---
  /** Operação OpenAPI com alguma resposta 2xx ou 3xx (operation-success-response do spectral:oas). */
  oasOpSuccessResponse: {
    run(v) {
      if (!isObject(v)) return []
      return Object.keys(v).some((k) => /^[23](\d\d|XX)$/i.test(k)) ? [] : [{ message: 'a operação não tem nenhuma resposta 2xx ou 3xx' }]
    }
  },
  /**
   * path-params do spectral:oas, sobre $.paths: cada {variável} do caminho tem o parâmetro in: path
   * com required: true (no caminho ou na operação), nenhum parâmetro de caminho sobra, nenhuma
   * variável se repete no mesmo caminho, e dois caminhos que só diferem no nome das variáveis
   * (/pedidos/{id} e /pedidos/{pedidoId}) não coexistem.
   */
  oasPathParam: {
    run(v) {
      if (!isObject(v)) return []
      const out: LintFunctionResult[] = []
      const seen = new Map<string, string>()
      for (const [path, item] of Object.entries(v)) {
        const vars = [...path.matchAll(/\{([^{}/]+)\}/g)].map((m) => m[1]!)
        const normalized = path.replace(/\{[^{}/]+\}/g, '{}')
        const twin = seen.get(normalized)
        if (twin !== undefined) out.push({ message: `os caminhos ${twin} e ${path} são equivalentes (só muda o nome das variáveis)`, path: [path] })
        else seen.set(normalized, path)
        const repeated = vars.find((name, i) => vars.indexOf(name) !== i)
        if (repeated) out.push({ message: `a variável {${repeated}} aparece mais de uma vez em ${path}`, path: [path] })
        if (!isObject(item)) continue
        const shared = pathParams(item['parameters'])
        for (const [method, op] of Object.entries(item)) {
          if (!OAS_METHODS.has(method) || !isObject(op)) continue
          const own = pathParams(op['parameters'])
          const defined = new Map([...shared, ...own])
          for (const name of new Set(vars)) {
            const p = defined.get(name)
            if (!p) out.push({ message: `${method.toUpperCase()} ${path}: a variável {${name}} não tem parâmetro in: path`, path: [path, method] })
            else if (p.required !== true) out.push({ message: `${method.toUpperCase()} ${path}: o parâmetro de caminho ${name} precisa de required: true`, path: [path, method, 'parameters', p.index] })
          }
          for (const [name, p] of own) {
            if (!vars.includes(name)) out.push({ message: `${method.toUpperCase()} ${path}: o parâmetro de caminho ${name} não aparece no caminho`, path: [path, method, 'parameters', p.index] })
          }
        }
        for (const [name, p] of shared) {
          if (!vars.includes(name)) out.push({ message: `${path}: o parâmetro de caminho ${name} não aparece no caminho`, path: [path, 'parameters', p.index] })
        }
      }
      return out
    }
  },
  /** operation-parameters do spectral:oas: na mesma operação, nenhum parâmetro repete in e nome (o nome do header sem caixa). */
  oasOpParams: {
    run(v) {
      if (!Array.isArray(v)) return []
      const out: LintFunctionResult[] = []
      const seen = new Set<string>()
      for (const [i, p] of v.entries()) {
        if (!isObject(p) || typeof p['name'] !== 'string' || typeof p['in'] !== 'string') continue
        const key = `${p['in']}:${p['in'] === 'header' ? p['name'].toLowerCase() : p['name']}`
        if (seen.has(key)) out.push({ message: `o parâmetro ${p['name']} (in: ${p['in']}) aparece mais de uma vez na operação`, path: [i] })
        seen.add(key)
      }
      return out
    }
  },
  /**
   * Auth do conector ($.auth[*]) que os endpoints contornam: com auth, um endpoint ou cenário que
   * manda o header dela (que troca a credencial só ali) ou outro header de credencial; sem auth,
   * parte dos endpoints com credencial no header e parte sem, ou cada um com um header diferente.
   */
  authConsistency: {
    run(v) {
      if (!isObject(v) || !Array.isArray(v['endpoints'])) return []
      const endpoints = v['endpoints'] as { id: string; credentialHeaders: string[]; scenarios: { id: string; credentialHeaders: string[] }[] }[]
      const out: LintFunctionResult[] = []
      if (v['auth']) {
        const from = v['from'] && v['from'] !== v['connector'] ? ` (herdada de ${String(v['from'])})` : ''
        const hint = `A credencial vem da auth ${String(v['auth'])} do conector${from}: tire o header do endpoint; se ele precisa de outra auth, crie um conector filho com ela.`
        for (const [i, e] of endpoints.entries()) {
          if (e.credentialHeaders.length) {
            out.push({ message: `o endpoint ${e.id} manda ${e.credentialHeaders.join(', ')} por conta própria, além da auth ${String(v['auth'])} do conector${from}`, path: ['endpoints', i], hint })
          }
          for (const [si, sc] of e.scenarios.entries()) {
            if (sc.credentialHeaders.length) {
              out.push({ message: `o cenário ${e.id}/${sc.id} troca ${sc.credentialHeaders.join(', ')} da auth ${String(v['auth'])} do conector${from}`, path: ['endpoints', i, 'scenarios', si], hint: `${hint} Para testar uma credencial errada de propósito, use uma variável de ambiente no cenário e diga isso na descrição.` })
            }
          }
        }
        return out
      }
      const withCredential = endpoints.filter((e) => e.credentialHeaders.length)
      if (!withCredential.length) return []
      const hint = 'Defina a auth no conector (config.auth), com a credencial numa variável {{NOME}} marcada como segredo: todos os endpoints passam a mandá-la, e o agente e a documentação sabem que ela existe.'
      if (withCredential.length < endpoints.length) {
        const without = endpoints.filter((e) => !e.credentialHeaders.length).map((e) => e.id)
        out.push({
          message: `${withCredential.length} de ${endpoints.length} endpoints mandam credencial no header (${withCredential.map((e) => e.id).join(', ')}) e ${without.length} vão sem (${without.slice(0, 5).join(', ')}${without.length > 5 ? '…' : ''})`,
          hint
        })
      }
      const kinds = new Set(withCredential.map((e) => e.credentialHeaders.join(',')))
      if (kinds.size > 1) out.push({ message: `os endpoints do conector mandam credenciais em headers diferentes (${[...kinds].join(' · ')})`, hint })
      else if (withCredential.length === endpoints.length) out.push({ message: `todos os endpoints mandam ${[...kinds][0]} à mão, sem auth no conector`, hint })
      return out
    }
  },
  /** Item de drift entre a documentação e o catálogo ($.drift[*]): a mensagem e o hint vêm prontos dele. */
  drift: {
    run(v) {
      if (!isObject(v) || typeof v['message'] !== 'string') return []
      return [{ message: v['message'], ...(typeof v['hint'] === 'string' && { hint: v['hint'] }) }]
    }
  },
  /** Lista sem itens repetidos (duplicated-entry-in-enum do spectral:oas). */
  uniqueItems: {
    run(v) {
      if (!Array.isArray(v)) return []
      const seen = new Set<string>()
      for (const [i, item] of v.entries()) {
        const key = JSON.stringify(item)
        if (seen.has(key)) return [{ message: `${describe(item)} aparece mais de uma vez`, path: [i] }]
        seen.add(key)
      }
      return []
    }
  }
}
