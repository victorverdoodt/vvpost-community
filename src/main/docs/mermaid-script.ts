import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * O mermaid.min.js que vai junto do site exportado quando os diagramas não viram imagem (o CLI e o
 * MCP sem o executável do VVPost, como no worker do VVBuilder): o navegador desenha a partir do
 * próprio site, sem CDN. O build copia o arquivo para out/main/vendor (e para o pacote npm do CLI);
 * no código-fonte, vem do node_modules. VVPOST_MERMAID_JS troca o arquivo.
 */
export const MERMAID_VENDOR = 'vendor/mermaid.min.js'

export async function loadMermaidScript(): Promise<string | null> {
  const candidates = [process.env['VVPOST_MERMAID_JS'], join(__dirname, MERMAID_VENDOR), join(__dirname, '..', MERMAID_VENDOR)]
  try {
    candidates.push(createRequire(__filename).resolve('mermaid/dist/mermaid.min.js'))
  } catch {
    // Sem o mermaid no node_modules (o pacote do CLI): só o vendor.
  }
  const file = candidates.find((p): p is string => !!p && existsSync(p))
  return file ? readFile(file, 'utf8') : null
}
