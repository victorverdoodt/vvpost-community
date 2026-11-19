import type { FlowNode } from '@vvpost/schemas'

/**
 * Erro ligado à propriedade do nó que o causou: a partir do código e da
 * mensagem do motor, o campo do nó que tem a referência, a variável ou o valor citado. O caminho
 * segue o arquivo do fluxo (`request.url`, `request.headers.Authorization`, `python.code`,
 * `plugin.config.query`), para o inspector marcar o campo e o CLI dizer onde corrigir.
 */
export function locateProperty(node: FlowNode, code: string, message: string): string | undefined {
  if (code === 'PYTHON_ERROR' && node.type === 'python') return 'python.code'
  if (code === 'PYTHON_NOT_FOUND' && node.type === 'python' && node.python.version && message.startsWith('O nó pede o Python')) return 'python.version'
  if (node.type === 'request') {
    if (/não tem o endpoint/.test(message)) return 'request.endpoint'
    if (/conector "[^"]*" não existe|herda de|herança/.test(message)) return 'request.connector'
  }
  const leaves = stringLeaves(node)
  const compact = (s: string) => s.replace(/\s+/g, '')
  for (const clue of clues(message)) {
    const found = leaves.find(([, value]) => compact(value).includes(compact(clue)))
    if (found) return found[0]
  }
  if (code === 'INVALID_URL' && node.type === 'request') return 'request.url'
  // A variável não está no nó: veio da herança do conector (baseUrl, headers, auth).
  if (code === 'CONFIG_ERROR' && node.type === 'request' && node.request.connector && /\{\{/.test(message))
    return 'request.connector'
  return undefined
}

/** O que a mensagem cita, do mais específico ao mais genérico: $nodes..., {{VAR}}, "texto". */
function clues(message: string): string[] {
  const found: string[] = []
  for (const m of message.matchAll(/\$nodes\.[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z0-9_$-]+)|\[[^\]]*\])*/g))
    found.push(m[0])
  for (const m of message.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const inner = m[1]!
    if (!inner.startsWith('$nodes')) found.push(`{{${inner}`, inner)
  }
  // Nó citado sem caminho ($nodes.Login: o nó Login ...): qualquer referência a ele serve.
  for (const m of message.matchAll(/\$nodes\.([A-Za-z_][A-Za-z0-9_]*)/g)) found.push(`$nodes.${m[1]}`)
  return [...new Set(found)]
}

/** Os textos do nó com o caminho de cada um, na ordem do formulário. */
function stringLeaves(node: FlowNode): [string, string][] {
  const out: [string, string][] = []
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') out.push([path, value])
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`))
    else if (value && typeof value === 'object') {
      // O corpo é um campo só no formulário: a propriedade é o corpo, não a chave dentro dele.
      if (path.endsWith('.body')) return out.push([path, JSON.stringify(value)])
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k)
    }
  }
  const { id: _id, name: _name, type: _type, position: _position, ...rest } = node as FlowNode & { position?: unknown }
  walk(rest, '')
  return out
}
