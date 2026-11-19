/**
 * Diff de linhas para o visualizador lado a lado do Git Workspace. JSON válido é
 * normalizado (indentação de 2 espaços) antes da comparação, para que só mudanças
 * de conteúdo apareçam; o resto é comparado como texto.
 */

export type DiffOp = { type: 'same' | 'removed' | 'added'; text: string }

export interface DiffCell {
  /** Número da linha, a partir de 1. */
  line: number
  text: string
}

export type DiffRow =
  | { kind: 'same' | 'changed' | 'removed' | 'added'; left?: DiffCell; right?: DiffCell }
  | { kind: 'gap'; hidden: number }

/** Acima disso o Myers desiste e mostra tudo como removido e adicionado. */
const MAX_EDIT_DISTANCE = 1000

export function normalizeJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text.replace(/\r\n/g, '\n').replace(/\n$/, '')
  }
}

export function splitLines(text: string | null): string[] {
  if (text === null || text === '') return []
  return text.split('\n')
}

/** Diff de linhas (Myers, O((N+M)·D)), depois de cortar prefixo e sufixo comuns. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head = a.slice(0, start).map((text): DiffOp => ({ type: 'same', text }))
  const tail = a.slice(endA).map((text): DiffOp => ({ type: 'same', text }))
  return [...head, ...myers(a.slice(start, endA), b.slice(start, endB)), ...tail]
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((text) => ({ type: 'added', text }))
  if (m === 0) return a.map((text) => ({ type: 'removed', text }))
  const max = Math.min(n + m, MAX_EDIT_DISTANCE)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = false
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
  }
  if (!found) {
    return [...a.map((text): DiffOp => ({ type: 'removed', text })), ...b.map((text): DiffOp => ({ type: 'added', text }))]
  }

  // Volta pelo trace montando as operações de trás para frente.
  const ops: DiffOp[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!
    const k = x - y
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1
    const prevX = vd[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ type: 'same', text: a[--x]! })
      y--
    }
    if (d === 0) break
    if (x === prevX) ops.push({ type: 'added', text: b[--y]! })
    else ops.push({ type: 'removed', text: a[--x]! })
  }
  return ops.reverse()
}

/**
 * Linhas para a vista lado a lado: remoções seguidas de adições viram pares
 * "changed"; trechos iguais maiores que 2·context viram uma linha "gap".
 */
export function sideBySide(ops: DiffOp[], context = 3): DiffRow[] {
  const rows: Exclude<DiffRow, { kind: 'gap' }>[] = []
  let left = 0
  let right = 0
  for (let i = 0; i < ops.length; ) {
    const op = ops[i]!
    if (op.type === 'same') {
      rows.push({ kind: 'same', left: { line: ++left, text: op.text }, right: { line: ++right, text: op.text } })
      i++
      continue
    }
    const removed: string[] = []
    const added: string[] = []
    while (i < ops.length && ops[i]!.type !== 'same') {
      const o = ops[i++]!
      if (o.type === 'removed') removed.push(o.text)
      else added.push(o.text)
    }
    for (let j = 0; j < Math.max(removed.length, added.length); j++) {
      const l = j < removed.length ? { line: ++left, text: removed[j]! } : undefined
      const r = j < added.length ? { line: ++right, text: added[j]! } : undefined
      rows.push({ kind: l && r ? 'changed' : l ? 'removed' : 'added', left: l, right: r })
    }
  }
  return collapse(rows, context)
}

function collapse(rows: Exclude<DiffRow, { kind: 'gap' }>[], context: number): DiffRow[] {
  const out: DiffRow[] = []
  for (let i = 0; i < rows.length; ) {
    if (rows[i]!.kind !== 'same') {
      out.push(rows[i++]!)
      continue
    }
    let j = i
    while (j < rows.length && rows[j]!.kind === 'same') j++
    const keepStart = i === 0 ? 0 : context
    const keepEnd = j === rows.length ? 0 : context
    if (j - i > keepStart + keepEnd + 1) {
      out.push(...rows.slice(i, i + keepStart))
      out.push({ kind: 'gap', hidden: j - i - keepStart - keepEnd })
      out.push(...rows.slice(j - keepEnd, j))
    } else {
      out.push(...rows.slice(i, j))
    }
    i = j
  }
  return out
}

/** Atalho do painel: normaliza, compara e monta as linhas lado a lado. */
export function jsonSideBySide(before: string | null, after: string | null, context = 3): DiffRow[] {
  const a = splitLines(before === null ? null : normalizeJson(before))
  const b = splitLines(after === null ? null : normalizeJson(after))
  return sideBySide(diffLines(a, b), context)
}
