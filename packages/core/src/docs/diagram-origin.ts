// Sem node:*: o renderer usa o mesmo formato da marca de origem e do nome dos diagramas novos.

/** Primeira linha que a montagem põe nos diagramas escritos: um comentário que o Mermaid ignora. */
export const DIAGRAM_ORIGIN = '%% vvpost:origem '
/** Onde o editor guarda os diagramas novos. */
export const DIAGRAMS_DIR = 'docs/diagramas'

export interface DiagramOrigin {
  /** Arquivo do workspace: um .md (com a linha da abertura do bloco) ou um .mmd. */
  file: string
  /** Linha (a partir de 1) do ```mermaid que abre o bloco; ausente num .mmd. */
  line?: number
}

/** A origem marcada no diagrama e o código sem a marca. */
export function splitDiagramOrigin(code: string): { origin?: DiagramOrigin; code: string } {
  const lines = code.replace(/\r\n?/g, '\n').split('\n')
  const first = lines[0] ?? ''
  if (!first.startsWith(DIAGRAM_ORIGIN)) return { code }
  const m = /^(.*?)(?::(\d+))?$/.exec(first.slice(DIAGRAM_ORIGIN.length).trim())!
  return { origin: { file: m[1]!, ...(m[2] && { line: Number(m[2]) }) }, code: lines.slice(1).join('\n') }
}

/** Slug do nome de um diagrama novo, sem a pasta: "Visão C4" vira "visao-c4". Vazio: nome inválido. */
export function diagramSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}
