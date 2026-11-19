#!/usr/bin/env node
// Gera os ícones do app a partir de resources/icon.svg: icon.png (512 px, janela no Linux e
// base para o instalador) e icon.ico (16 a 256 px, janela e barra de tarefas no Windows).
// Uso: node scripts/make-icons.mjs   (Linux sem display: xvfb-run -a)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const resources = join(dirname(fileURLToPath(import.meta.url)), '../resources')
const svg = readFileSync(join(resources, 'icon.svg'), 'utf8')
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const render = async (size) => {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  )
  const png = await page.screenshot({ omitBackground: true })
  await page.close()
  return png
}

writeFileSync(join(resources, 'icon.png'), await render(512))

// ICO com entradas PNG (aceito pelo Windows desde o Vista).
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = []
for (const size of sizes) images.push(await render(size))
await browser.close()
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((size, i) => {
  const at = 6 + 16 * i
  header.writeUInt8(size >= 256 ? 0 : size, at)
  header.writeUInt8(size >= 256 ? 0 : size, at + 1)
  header.writeUInt16LE(1, at + 4)
  header.writeUInt16LE(32, at + 6)
  header.writeUInt32LE(images[i].length, at + 8)
  header.writeUInt32LE(offset, at + 12)
  offset += images[i].length
})
writeFileSync(join(resources, 'icon.ico'), Buffer.concat([header, ...images]))
console.log('resources/icon.png e resources/icon.ico gerados')
