import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { escapeHtml, type PrintLayout } from '@vvpost/core/docs/theme'

/** HTML maior que isto não é documento, é acidente (ou abuso do IPC). */
export const MAX_PDF_HTML_BYTES = 24 * 1024 * 1024

/**
 * Documento completo de impressão em volta do conteúdo (já sanitizado no renderer), com o
 * estilo e a capa do modelo do projeto (core/docs/theme). O estilo fica no main: o renderer
 * só manda o conteúdo, e a CSP impede qualquer carga externa.
 */
export function printDocument(title: string, body: string, layout: PrintLayout): string {
  return [
    '<!doctype html>',
    '<html lang="pt-BR"><head><meta charset="utf-8">',
    // Sem script, sem rede: só o estilo inline e imagens data: (os SVGs do Mermaid vêm inline).
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${layout.css}</style>`,
    `</head><body>${layout.cover}<main>${body}</main></body></html>`
  ].join('')
}

/**
 * Imprime o HTML em PDF numa janela oculta, sem JavaScript e sem navegação, e devolve
 * os bytes. A página vai por um arquivo temporário (um data: URL grande falha).
 */
export async function htmlToPdf(html: string, layout: PrintLayout): Promise<Buffer> {
  const file = join(app.getPath('temp'), `vvpost-docs-${randomUUID()}.html`)
  await writeFile(file, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1400,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  try {
    await win.loadFile(file)
    return await win.webContents.printToPDF({
      pageSize: layout.pdf.pageSize,
      landscape: layout.pdf.landscape,
      printBackground: true,
      margins: layout.pdf.margins,
      displayHeaderFooter: true,
      headerTemplate: layout.headerTemplate,
      footerTemplate: layout.footerTemplate,
      generateDocumentOutline: true,
      generateTaggedPDF: true
    })
  } finally {
    win.destroy()
    await rm(file, { force: true })
  }
}
