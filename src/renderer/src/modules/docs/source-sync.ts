import { directiveAt } from './references'

// Puro (sem DOM nem Monaco), para os testes de unidade. A ligação entre a prévia e o texto segue a
// da prévia de Markdown do VS Code: cada bloco da prévia sabe a linha do texto de onde veio
// (data-line), e a rolagem de um lado acha o bloco do outro e interpola entre dois blocos.

/** Um ponto de amarração: a linha do texto (de 1) e a altura, na prévia, do primeiro bloco dela. */
export interface SyncAnchor {
  line: number
  top: number
}

/**
 * Os pontos de amarração a partir dos blocos da prévia (a linha do texto montado e a altura de
 * cada um) e do mapa do texto montado para o fonte. Blocos que a montagem criou (sumário) e os
 * seguintes de uma mesma linha do fonte (o trecho inteiro de um include) não amarram: a linha
 * fica no primeiro bloco dela, e a rolagem passa pelo trecho entre ela e a próxima linha.
 */
export function syncAnchors<T extends { line: number; top: number }>(blocks: readonly T[], sourceLines: readonly number[]): (SyncAnchor & { block: T })[] {
  const anchors: (SyncAnchor & { block: T })[] = []
  for (const b of blocks) {
    const line = sourceLines[b.line] ?? 0
    if (line > (anchors.at(-1)?.line ?? 0)) anchors.push({ line, top: b.top, block: b })
  }
  return anchors
}

/** A altura da prévia que corresponde a uma linha do texto (fracionária: o meio da linha 10 é 10.5). */
export function previewTopForLine(anchors: readonly SyncAnchor[], line: number): number | null {
  if (!anchors.length) return null
  let i = anchors.findLastIndex((a) => a.line <= line)
  if (i < 0) return anchors[0]!.top * Math.max(0, Math.min(1, (line - 1) / Math.max(1, anchors[0]!.line - 1)))
  const a = anchors[i]!
  const b = anchors[++i]
  if (!b) return a.top
  return a.top + ((line - a.line) / (b.line - a.line)) * (b.top - a.top)
}

/** A linha do texto (fracionária) que corresponde a uma altura da prévia. */
export function lineForPreviewTop(anchors: readonly SyncAnchor[], top: number): number | null {
  if (!anchors.length) return null
  let i = anchors.findLastIndex((a) => a.top <= top)
  if (i < 0) return 1
  const a = anchors[i]!
  const b = anchors[++i]
  if (!b || b.top <= a.top) return a.line
  return a.line + ((top - a.top) / (b.top - a.top)) * (b.line - a.line)
}

/**
 * As linhas do texto que um bloco da prévia representa, para destacar no editor: da linha dele até
 * antes da próxima linha que tem bloco, sem as linhas em branco do fim. Um bloco de um trecho
 * montado (include, conector) cai na linha da diretiva.
 */
export function sourceRange(sourceLines: readonly number[], block: number, text: string): { from: number; to: number } | null {
  const from = sourceLines[block] ?? 0
  if (!from) return null
  const lines = text.split('\n')
  const next = sourceLines.find((l, i) => i > block && l > from) ?? lines.length + 1
  let to = Math.max(from, Math.min(lines.length, next - 1))
  while (to > from && !lines[to - 1]!.trim()) to--
  return { from, to }
}

/** O trecho que uma diretiva do texto monta, para mostrar embaixo dela no próprio texto. */
export interface InlinePreview {
  /** A linha da diretiva (de 1). */
  line: number
  /** A diretiva, de {{> até }}. */
  directive: string
  kind: string
  /** O Markdown montado (já sanitizado, como na prévia). */
  markdown: string
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/

function directiveLines(text: string): { line: number; directive: string; kind: string }[] {
  const found: { line: number; directive: string; kind: string }[] = []
  let fence = false
  text.split('\n').forEach((line, i) => {
    if (FENCE.test(line)) fence = !fence
    const d = !fence && line.includes('{{>') ? directiveAt(line) : null
    if (d) found.push({ line: i + 1, directive: d.text, kind: d.kind })
  })
  return found
}

/**
 * O trecho de cada diretiva, tirado do documento já montado (sem montar de novo): as linhas do
 * texto montado que vêm da linha da diretiva. source é o texto que foi montado.
 */
export function inlinePreviews(source: string, printMarkdown: string, sourceLines: readonly number[]): InlinePreview[] {
  const out = printMarkdown.split('\n')
  const byLine = new Map<number, string[]>()
  sourceLines.forEach((l, i) => {
    if (!l) return
    let list = byLine.get(l)
    if (!list) byLine.set(l, (list = []))
    list.push(out[i] ?? '')
  })
  return directiveLines(source).map((d) => ({ ...d, markdown: (byLine.get(d.line) ?? []).join('\n').trim() }))
}

/**
 * As prévias de uma montagem anterior no texto de agora: enquanto a pessoa digita, as linhas
 * mudam antes da próxima montagem. Cada prévia vai para a mesma diretiva mais perto da linha
 * antiga; a diretiva que sumiu perde a prévia.
 */
export function placePreviews(previews: readonly InlinePreview[], text: string): InlinePreview[] {
  const now = directiveLines(text)
  const used = new Set<number>()
  const placed: InlinePreview[] = []
  for (const p of previews) {
    let best: number | null = null
    for (const d of now) {
      if (d.directive !== p.directive || used.has(d.line)) continue
      if (best === null || Math.abs(d.line - p.line) < Math.abs(best - p.line)) best = d.line
    }
    if (best === null) continue
    used.add(best)
    placed.push({ ...p, line: best })
  }
  return placed
}
