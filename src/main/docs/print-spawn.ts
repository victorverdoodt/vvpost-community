import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DiagramJob, PrintJob } from './print-worker'

/** Uma impressão não passa disto (Mermaid de um documento grande leva segundos, não minutos). */
const PRINT_TIMEOUT_MS = 180_000

/**
 * Executável e argumentos que abrem o VVPost em modo de impressão, de onde quer que o chamador
 * rode: dentro do app (o próprio executável), no mcp.js pelo executável do app com
 * ELECTRON_RUN_AS_NODE (instalado, app.asar) ou em Node puro no código-fonte (o Electron do
 * node_modules com out/main/index.js). VVPOST_ELECTRON troca o executável.
 */
export function printCommand(flag: string): { command: string; args: string[] } | null {
  const override = process.env['VVPOST_ELECTRON']
  const entry = process.argv[1] ?? ''
  const packaged = entry.includes('app.asar') || __dirname.includes('app.asar')
  // No código-fonte, o index.js fica ao lado do mcp.js e do cli.js em out/main.
  const index = [join(dirname(entry), 'index.js'), join(__dirname, 'index.js'), join(__dirname, '..', 'index.js')].find((p) => existsSync(p))
  if (process.versions['electron'] && !override) {
    if (packaged) return { command: process.execPath, args: [flag] }
    return index ? { command: process.execPath, args: [index, flag] } : null
  }
  const electron = override ?? installedElectron(join(process.cwd(), 'noop.js')) ?? installedElectron(__filename)
  if (!electron || !index) return null
  return { command: electron, args: [index, flag] }
}

/**
 * O executável do pacote electron do node_modules, sem o require('electron'): sem o binário,
 * o require baixa o Electron escrevendo no stdout (quebra o protocolo do mcp.js) e trava sem rede.
 */
function installedElectron(from: string): string | null {
  try {
    const dir = dirname(createRequire(from).resolve('electron/package.json'))
    const pathFile = join(dir, 'path.txt')
    if (!existsSync(pathFile)) return null
    const executable = join(dir, 'dist', readFileSync(pathFile, 'utf8').trim())
    return existsSync(executable) ? executable : null
  } catch {
    return null
  }
}

/** Imprime o pedido num processo do VVPost em modo de impressão e espera o PDF ficar pronto. */
export async function printInSubprocess(job: PrintJob): Promise<void> {
  await runPrintProcess(job)
}

/**
 * Desenha diagramas Mermaid num processo do VVPost em modo de impressão (o CLI não tem o
 * Mermaid). null quando não há executável do VVPost por perto (o pacote npm sozinho).
 */
export async function renderDiagramsInSubprocess(diagrams: { id: string; source: string }[], format: 'svg' | 'png'): Promise<{ id: string; data: Uint8Array }[] | null> {
  if (!diagrams.length) return []
  if (!printCommand('--vvpost-print=x')) return null
  const dir = await mkdtemp(join(tmpdir(), 'vvpost-diagrams-'))
  try {
    const out = join(dir, 'diagrams.json')
    await runPrintProcess({ kind: 'diagrams', diagrams, format, out })
    const list = JSON.parse(await readFile(out, 'utf8')) as { id: string; base64: string }[]
    return list.map((d) => ({ id: d.id, data: new Uint8Array(Buffer.from(d.base64, 'base64')) }))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function runPrintProcess(job: PrintJob | DiagramJob): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'vvpost-print-'))
  const jobFile = join(dir, `${randomUUID()}.json`)
  try {
    await writeFile(jobFile, JSON.stringify(job))
    const cmd = printCommand(`--vvpost-print=${jobFile}`)
    if (!cmd) throw new Error('não achei o executável do VVPost para imprimir o PDF (instale o app, defina VVPOST_ELECTRON ou, no código-fonte, baixe o Electron com npx install-electron)')
    const env = { ...process.env }
    delete env['ELECTRON_RUN_AS_NODE']
    delete env['ELECTRON_RENDERER_URL']
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd.command, [...cmd.args, ...sandboxArgs(cmd.command), `--user-data-dir=${join(dir, 'profile')}`], {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      })
      let stderr = ''
      child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
      const timer = setTimeout(() => child.kill(), PRINT_TIMEOUT_MS)
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) return resolve()
        const reason = /VVPOST_PRINT_ERROR: (.+)/.exec(stderr)?.[1]
        reject(new Error(reason ?? `a impressão saiu com código ${code}`))
      })
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * --no-sandbox quando o Chromium não abriria com a sandbox: como root no Linux (o contêiner de CI
 * comum) ou num Linux que restringe user namespaces sem privilégio (Ubuntu 24.04 com AppArmor, o
 * runner do GitHub) com um chrome-sandbox que não é setuid root (o Electron do node_modules). Ali o
 * processo de impressão morria na hora e os diagramas do site exportado não viravam imagem.
 */
export function sandboxArgs(executable: string): string[] {
  if (process.platform !== 'linux') return []
  if (process.getuid?.() === 0) return ['--no-sandbox']
  try {
    if (readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() !== '1') return []
  } catch {
    return []
  }
  try {
    const helper = statSync(join(dirname(executable), 'chrome-sandbox'))
    if (helper.uid === 0 && (helper.mode & 0o4000) !== 0) return []
  } catch {
    // Sem o chrome-sandbox não há sandbox de setuid para cair.
  }
  return ['--no-sandbox']
}
