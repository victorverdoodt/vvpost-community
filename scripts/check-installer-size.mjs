#!/usr/bin/env node
// Confere o tamanho dos instaladores em dist/ contra installerMB de perf-budgets.json (meta:
// < 85 MB; o .exe do Windows tem meta própria, exeMax). MB aqui é MiB (1024 × 1024 bytes), como o Explorer, o Finder em modo binário e o
// `du -h` mostram. Também confere que um build Community não leva o módulo Enterprise.
// Uso: npm run dist && npm run check:installer
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const { installerMB } = JSON.parse(readFileSync(join(root, 'perf-budgets.json'), 'utf8'))
// O que a pessoa baixa para instalar. O .zip do macOS é o pacote de atualização; o AppImage é
// opcional e fica de fora da meta (docs/packaging.md).
const INSTALLERS = /\.(exe|dmg|deb|tar\.xz)$/

if (!existsSync(dist)) {
  console.error('dist/ não existe. Rode "npm run dist" antes.')
  process.exit(1)
}
const found = readdirSync(dist).filter((name) => INSTALLERS.test(name))
if (found.length === 0) {
  console.error('Nenhum instalador em dist/.')
  process.exit(1)
}

let over = false
for (const name of found) {
  const bytes = statSync(join(dist, name)).size
  const mb = bytes / 1024 / 1024
  const max = name.endsWith('.exe') ? (installerMB.exeMax ?? installerMB.max) : installerMB.max
  const ok = mb < max
  over ||= !ok
  console.log(`${ok ? 'ok  ' : 'ACIMA'} ${name}: ${mb.toFixed(1)} MB (${bytes} bytes; meta < ${max} MB)`)
}

// Um build sem VVPOST_ENTERPRISE_DIR (sem -enterprise no nome) não pode levar o módulo.
for (const name of readdirSync(dist)) {
  if (!/-unpacked$|^mac/.test(name)) continue
  const resources = name.startsWith('mac') ? null : join(dist, name, 'resources')
  if (resources && existsSync(join(resources, 'enterprise')) && !found.some((f) => f.includes('-enterprise'))) {
    console.error(`${name}: build Community com resources/enterprise.`)
    process.exit(1)
  }
}

if (over && installerMB.enforce) process.exit(1)
