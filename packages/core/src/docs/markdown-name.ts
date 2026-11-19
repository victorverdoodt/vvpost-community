import { diagramSlug } from './diagram-origin'

/** Nome de arquivo para um documento novo: docs/<nome>.md. Sem dependência de Node (o renderer usa). */
export function markdownFileName(name: string): string {
  const slug = diagramSlug(name)
  if (!slug) throw new Error('dê um nome ao documento')
  return `docs/${slug}.md`
}
