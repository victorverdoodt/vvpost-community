// Página de impressão do PDF fora da janela do app (export_docs do MCP, `vvpost docs --pdf`):
// o mesmo marked + DOMPurify + Mermaid da tela, sem React e sem a ponte do preload. O processo
// de impressão (src/main/docs/print-worker.ts) chama window.vvpostPrintHtml(markdown).
import { markdownToPrintHtml, renderMermaid } from './design-system/content/Markdown'

declare global {
  interface Window {
    vvpostPrintHtml(markdown: string, mermaidInit?: string): Promise<string>
    /** Os diagramas do "Enviar para…" fora do app (vvpost docs export): SVG no tema claro; o que falhar fica de fora. */
    vvpostRenderDiagrams(list: { id: string; source: string }[]): Promise<{ id: string; svg: string }[]>
  }
}

// Sem preload aqui: os ícones de plugins não entram, só o pacote vv do próprio app.
const w = window as unknown as { vvpost?: unknown }
w.vvpost ??= { diagramCatalog: async () => ({ ok: false }) }

window.vvpostPrintHtml = (markdown, mermaidInit) => markdownToPrintHtml(markdown, mermaidInit)
window.vvpostRenderDiagrams = async (list) => {
  const out: { id: string; svg: string }[] = []
  for (const d of list) {
    const r = await renderMermaid(/^\s*%%\{init/.test(d.source) ? d.source : `%%{init: {"theme": "default"}}%%\n${d.source}`)
    if ('svg' in r) out.push({ id: d.id, svg: r.svg })
  }
  return out
}
document.title = 'ready'
