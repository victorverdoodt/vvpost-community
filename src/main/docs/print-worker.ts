import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import type { PrintLayout } from '@vvpost/core/docs/theme'
import { htmlToPdf, MAX_PDF_HTML_BYTES, printDocument } from './pdf'

/** Pedido de impressão gravado por quem roda fora do Electron (o export_docs do MCP). */
export interface PrintJob {
  kind?: 'pdf'
  title: string
  /** Markdown já sanitizado (printMarkdown do documento). */
  markdown: string
  layout: PrintLayout
  out: string
}

/** Diagramas Mermaid → SVG ou PNG para quem roda fora do Electron (vvpost docs export). Grava um JSON em out. */
export interface DiagramJob {
  kind: 'diagrams'
  diagrams: { id: string; source: string }[]
  format: 'svg' | 'png'
  out: string
}

/** Argumento que liga o modo de impressão do executável (lido em src/main/index.ts): --vvpost-print=<job.json>. */
export const PRINT_FLAG = '--vvpost-print='

/**
 * Imprime o pedido sem abrir o app: a página print.html converte o Markdown (o mesmo marked,
 * DOMPurify e Mermaid da tela), e a janela sem JavaScript do PDF do app imprime com o modelo.
 */
export async function runPrintJob(jobFile: string): Promise<void> {
  const job = JSON.parse(await readFile(jobFile, 'utf8')) as PrintJob | DiagramJob
  if (job.kind === 'diagrams') return runDiagramJob(job)
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1400,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  let html: string
  try {
    await loadPrintPage(win)
    html = (await win.webContents.executeJavaScript(`window.vvpostPrintHtml(${JSON.stringify(job.markdown)}, ${JSON.stringify(job.layout.mermaidInit)})`)) as string
  } finally {
    win.destroy()
  }
  if (Buffer.byteLength(html) > MAX_PDF_HTML_BYTES) throw new Error('documento grande demais para o PDF')
  const pdf = await htmlToPdf(printDocument(job.title, html, job.layout), job.layout)
  await writeFile(job.out, pdf)
}

/** A página print.html desenha os diagramas; o PNG sai da janela sem JavaScript do svgToPng. */
async function runDiagramJob(job: DiagramJob): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1400,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  let svgs: { id: string; svg: string }[]
  try {
    await loadPrintPage(win)
    svgs = (await win.webContents.executeJavaScript(`window.vvpostRenderDiagrams(${JSON.stringify(job.diagrams.slice(0, 500))})`)) as { id: string; svg: string }[]
  } finally {
    win.destroy()
  }
  const [{ svgToPng }, { svgFile }] = await Promise.all([import('./svg-png'), import('@vvpost/core/docs/publish')])
  const out: { id: string; base64: string }[] = []
  for (const d of svgs) {
    if (typeof d?.svg !== 'string' || !d.svg.startsWith('<svg')) continue
    const data = job.format === 'svg' ? new TextEncoder().encode(svgFile(d.svg)) : await svgToPng(d.svg)
    if (data) out.push({ id: d.id, base64: Buffer.from(data).toString('base64') })
  }
  await writeFile(job.out, JSON.stringify(out))
}

async function loadPrintPage(win: BrowserWindow): Promise<void> {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) return win.loadURL(`${devServerUrl}/print.html`)
  // Este módulo vai num chunk (out/main/chunks): a página fica em out/renderer.
  const page = [join(__dirname, '../renderer/print.html'), join(__dirname, '../../renderer/print.html')].find((p) => existsSync(p))
  if (!page) throw new Error('print.html não está no build')
  await win.loadFile(page)
}
