/**
 * Marcadores de conflito do Git num arquivo do working tree, para resolver bloco a
 * bloco (estilo VS Code). Entende o formato padrão e o diff3/zdiff3 (com `|||||||`).
 */

export type ConflictSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'conflict'
      /** Linhas da branch local (entre <<<<<<< e =======), com as quebras de linha. */
      ours: string
      /** Linhas do ancestral comum, só no estilo diff3. */
      base?: string
      /** Linhas que vieram do remoto (entre ======= e >>>>>>>). */
      theirs: string
      oursLabel: string
      theirsLabel: string
    }

export type ConflictChoice = 'ours' | 'theirs' | 'both'

const OPEN = /^<{7}(?: (.*))?$/
const BASE = /^\|{7}(?: .*)?$/
const SEP = /^={7}$/
const CLOSE = /^>{7}(?: (.*))?$/

/** Quebra o texto em trechos comuns e blocos em conflito. Marcador sem fechamento vira texto. */
export function parseConflicts(text: string): ConflictSegment[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const out: ConflictSegment[] = []
  let plain = ''
  let i = 0
  const strip = (l: string) => l.replace(/\r?\n$/, '')
  while (i < lines.length) {
    const open = OPEN.exec(strip(lines[i]!))
    if (!open) {
      plain += lines[i++]
      continue
    }
    // Procura o bloco inteiro antes de aceitá-lo.
    let j = i + 1
    let ours = ''
    let base: string | undefined
    let theirs = ''
    let stage: 'ours' | 'base' | 'theirs' = 'ours'
    let closed: RegExpExecArray | null = null
    for (; j < lines.length; j++) {
      const l = strip(lines[j]!)
      if (stage === 'ours' && BASE.test(l)) {
        stage = 'base'
        base = ''
      } else if (stage !== 'theirs' && SEP.test(l)) stage = 'theirs'
      else if (stage === 'theirs' && (closed = CLOSE.exec(l))) break
      else if (stage === 'ours') ours += lines[j]
      else if (stage === 'base') base += lines[j]!
      else theirs += lines[j]
    }
    if (!closed) {
      plain += lines[i++]
      continue
    }
    if (plain) out.push({ kind: 'text', text: plain })
    plain = ''
    out.push({
      kind: 'conflict',
      ours,
      ...(base !== undefined && { base }),
      theirs,
      oursLabel: open[1] ?? '',
      theirsLabel: closed[1] ?? ''
    })
    i = j + 1
  }
  if (plain) out.push({ kind: 'text', text: plain })
  return out
}

export function countConflicts(segments: ConflictSegment[]): number {
  return segments.filter((s) => s.kind === 'conflict').length
}

/**
 * Texto final com uma escolha por bloco, na ordem dos blocos. Bloco sem escolha
 * continua com os marcadores.
 */
export function applyChoices(segments: ConflictSegment[], choices: (ConflictChoice | undefined)[]): string {
  let n = 0
  return segments
    .map((s) => {
      if (s.kind === 'text') return s.text
      const choice = choices[n++]
      if (choice === 'ours') return s.ours
      if (choice === 'theirs') return s.theirs
      if (choice === 'both') return s.ours + (s.ours && !s.ours.endsWith('\n') ? '\n' : '') + s.theirs
      return (
        `<<<<<<< ${s.oursLabel}\n${s.ours}` +
        (s.base !== undefined ? `||||||| base\n${s.base}` : '') +
        `=======\n${s.theirs}>>>>>>> ${s.theirsLabel}\n`
      )
    })
    .join('')
}

/** O texto ainda tem um bloco de conflito completo. */
export function hasConflictMarkers(text: string): boolean {
  return countConflicts(parseConflicts(text)) > 0
}
