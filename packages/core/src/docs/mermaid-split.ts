/**
 * Divide um fluxograma Mermaid alto demais para uma página em um diagrama por etapa: cada
 * subgraph de primeiro nível vira um diagrama, e as setas que atravessam etapas viram pontas
 * ("vem de" e "segue em"). Só divide o que dá para dividir sem perder nada: fluxograma com duas
 * ou mais etapas e nenhum nó ou seta fora delas. Nos outros casos devolve null, e o diagrama
 * fica inteiro.
 */
export interface DiagramPart {
  title: string
  source: string
}

const HEADER = /^\s*(flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/
const SUBGRAPH = /^\s*subgraph\s+([A-Za-z_][\w-]*)\s*(?:\[\s*"?(.*?)"?\s*\])?\s*$/
const ARROW = /\s*(?:<?-->|<?---|-\.->|-\.-|<?==>|===|--\s[^>]*?-->|-\.\s[^>]*?\.->)\s*(?:\|[^|]*\|)?\s*/
const NODE_ID = /^([A-Za-z_][\w]*)/
/** Um nó com forma e rótulo: A["texto"], B{"texto"}, C(["texto"]) ou A[texto]. */
const SHAPED = /\b([A-Za-z_][\w]*)\s*(\(\[|\[\[|\[\(|\(\(|\{\{|\[|\(|\{|>)\s*(?:"([^"]*)"|([^"\]\)\}|]+))/g

/** Texto entre aspas sai do caminho, para uma seta dentro de um rótulo não contar como seta. */
const withoutQuoted = (line: string) => line.replace(/"[^"]*"/g, '""')

function idsIn(line: string): string[] {
  const clean = withoutQuoted(line).replace(/:::[\w-]+/g, '')
  return clean
    .split(ARROW)
    .flatMap((segment) => segment.split('&'))
    .map((segment) => NODE_ID.exec(segment.trim())?.[1])
    .filter((id): id is string => !!id && !['subgraph', 'end', 'direction', 'class', 'classDef', 'style', 'linkStyle', 'click'].includes(id))
}

export function splitFlowchart(text: string): DiagramPart[] | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const headerAt = lines.findIndex((l) => l.trim() && !l.trim().startsWith('%%'))
  if (headerAt < 0 || !HEADER.test(lines[headerAt]!)) return null
  const header = lines.slice(0, headerAt + 1)

  const blocks: { id: string; title: string; body: string[] }[] = []
  const globals: string[] = []
  let depth = 0
  for (const line of lines.slice(headerAt + 1)) {
    const t = line.trim()
    if (depth === 0) {
      const m = SUBGRAPH.exec(line)
      if (m) {
        blocks.push({ id: m[1]!, title: m[2] || m[1]!, body: [line] })
        depth = 1
        continue
      }
      if (!t || t.startsWith('%%')) continue
      // Fora das etapas só cabe estilo: um nó ou seta solto não tem etapa para ir.
      if (!/^(classDef|class|style|linkStyle|click)\b/.test(t)) return null
      globals.push(line)
      continue
    }
    blocks.at(-1)!.body.push(line)
    if (/^subgraph\b/.test(t)) depth++
    else if (t === 'end') depth--
  }
  if (depth !== 0 || blocks.length < 2) return null

  // De quem é cada nó: da etapa em que aparece primeiro com forma (rótulo), ou da primeira que o cita.
  const owner = new Map<string, number>()
  const label = new Map<string, string>()
  blocks.forEach((b, i) => {
    for (const line of b.body.slice(1, -1)) {
      for (const m of line.matchAll(SHAPED)) {
        const id = m[1]!
        if (owner.has(id) || !idsIn(line).includes(id)) continue
        owner.set(id, i)
        const text = (m[3] ?? m[4] ?? '').trim()
        if (text) label.set(id, text)
      }
    }
  })
  blocks.forEach((b, i) => {
    for (const line of b.body.slice(1, -1)) for (const id of idsIn(line)) if (!owner.has(id)) owner.set(id, i)
  })

  const short = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s).replace(/"/g, "'")
  return blocks.map((b, i) => {
    const mine = new Set([...owner].filter(([, at]) => at === i).map(([id]) => id))
    const stubs: string[] = []
    // Nós de outra etapa citados aqui: ponta "vem de" (ou "vai para") com o rótulo deles.
    const foreign = new Set<string>()
    for (const line of b.body.slice(1, -1)) for (const id of idsIn(line)) if (!mine.has(id)) foreign.add(id)
    for (const id of foreign) {
      const from = blocks[owner.get(id) ?? i]?.title ?? ''
      stubs.push(`  ${id}(["${short(label.get(id) ?? id)} · ${short(from)}"]):::vvStep`)
    }
    // Nós daqui citados nas etapas seguintes: ponta "segue em".
    const next = new Map<string, Set<number>>()
    blocks.forEach((other, j) => {
      if (j === i) return
      for (const line of other.body.slice(1, -1)) for (const id of idsIn(line)) if (mine.has(id)) next.set(id, (next.get(id) ?? new Set()).add(j))
    })
    for (const [id, targets] of next) {
      for (const j of targets) {
        const stub = `vvNext_${id}_${j}`
        stubs.push(`  ${stub}(["segue em: ${short(blocks[j]!.title)}"]):::vvStep`, `  ${id} -.-> ${stub}`)
      }
    }
    const present = new Set([...mine, ...foreign])
    // Estilos: classDef sempre; class e style só com os nós desta etapa (um id de fora criaria um nó solto).
    const styles = globals.flatMap((line) => {
      const t = line.trim()
      if (t.startsWith('classDef')) return [line]
      if (t.startsWith('class ')) {
        const [, ids = '', name = ''] = /^class\s+(\S+)\s+(\S+)/.exec(t) ?? []
        const kept = ids.split(',').filter((id) => present.has(id))
        return kept.length ? [`  class ${kept.join(',')} ${name}`] : []
      }
      if (t.startsWith('style ')) return present.has(t.split(/\s+/)[1] ?? '') ? [line] : []
      return []
    })
    return {
      title: b.title,
      source: [...header, ...b.body, ...stubs, ...styles, '  classDef vvStep fill:#ffffff,stroke:#8a93a8,stroke-dasharray:4 3,color:#3d4560'].join('\n')
    }
  })
}
