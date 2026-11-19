import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { svgSize } from './svg-size'

const MAX_SIDE = 4000

/**
 * SVG de um diagrama (desenhado pelo Mermaid no renderer) → PNG, numa janela oculta e
 * sem JavaScript: o SVG entra como <img> data:, então nenhum script dele roda. Escala 2
 * para o diagrama não ficar borrado no destino. null quando não deu.
 */
export async function svgToPng(svg: string): Promise<Uint8Array | null> {
  const size = svgSize(svg)
  if (!size) return null
  const width = Math.min(MAX_SIDE, Math.ceil(size.width))
  const height = Math.min(MAX_SIDE, Math.ceil(size.height))
  const src = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    '<style>html,body{margin:0;background:#fff}img{display:block}</style>',
    `</head><body><img src="${src}" width="${width}" height="${height}"></body></html>`
  ].join('')
  const file = join(app.getPath('temp'), `vvpost-diagrama-${randomUUID()}.html`)
  await writeFile(file, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, offscreen: true, zoomFactor: 2 }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  try {
    await win.loadFile(file)
    const image = await win.webContents.capturePage({ x: 0, y: 0, width, height })
    if (image.isEmpty()) return null
    return new Uint8Array(image.toPNG())
  } catch {
    return null
  } finally {
    win.destroy()
    await rm(file, { force: true })
  }
}
