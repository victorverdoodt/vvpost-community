#!/usr/bin/env node
// GIFs da documentação a partir do app real (build de produção em out/), no mesmo projeto de
// demonstração e contra a mesma API de mentira de docs-screenshots.mjs. Cada cena grava os quadros
// da janela enquanto a interação acontece e o ffmpeg monta um GIF leve (paleta própria, só a área
// que muda entre quadros) em docs/assets/gifs.
// Uso: npm run build && node scripts/docs-gifs.mjs [cena...]   (Linux sem display: xvfb-run -a)
// Precisa do ffmpeg no PATH. VVPOST_GIFS_DIR troca a pasta de saída, VVPOST_GIFS_WIDTH a largura
// (padrão 960; a janela fica em 1280x800) e VVPOST_GIFS_FORMAT=webp grava WebP animado (o site usa
// 1280 de largura em WebP). VVPOST_GIFS_DEBUG=1 mostra as respostas do MCP e
// grava a tela de uma cena que falhou. Só dados fictícios; nenhum segredo aparece.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { demoServer } from './demo-server.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const out = process.env.VVPOST_GIFS_DIR ?? join(root, 'docs/assets/gifs')
const gifWidth = Number(process.env.VVPOST_GIFS_WIDTH ?? 960)
const format = process.env.VVPOST_GIFS_FORMAT ?? 'gif'
const [width, height] = [1280, 800]
mkdirSync(out, { recursive: true })
const only = new Set(process.argv.slice(2))

const server = demoServer()
await new Promise((r) => server.once('error', () => server.listen(0, '127.0.0.1', r)).listen(4010, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const workspace = join(mkdtempSync(join(tmpdir(), 'vvpost-gifs-')), 'acme-payments')
cpSync(join(root, 'examples/demo-workspace'), workspace, { recursive: true })
for (const env of ['dev', 'staging']) {
  const file = join(workspace, `environments/${env}.env.json`)
  writeFileSync(file, readFileSync(file, 'utf8').replace('http://127.0.0.1:4010', origin))
}
mkdirSync(join(workspace, '.vvpost'))
writeFileSync(join(workspace, '.vvpost/secrets.local.json'), JSON.stringify({ 'env.dev': { CLIENT_SECRET: 'demo-secret' } }))
const userData = mkdtempSync(join(tmpdir(), 'vvpost-gifs-data-'))
writeFileSync(join(userData, 'workspace.json'), JSON.stringify({ dir: workspace }))

// Como root (contêiner de CI), o Electron só abre com --no-sandbox, inclusive o da impressão do PDF.
const rootUser = process.getuid?.() === 0
let printElectron
if (rootUser) {
  printElectron = join(userData, 'electron-no-sandbox.sh')
  writeFileSync(printElectron, `#!/bin/sh\nexec "${electronBin}" --no-sandbox "$@"\n`, { mode: 0o755 })
}

// Cliente MCP mínimo por stdio, como um agente usaria: as chamadas da cena do agente são reais.
const mcp = () => {
  const proc = spawn(process.execPath, [join(root, 'out/main/mcp.js'), '--workspace', workspace], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: printElectron ? { ...process.env, VVPOST_ELECTRON: printElectron } : process.env
  })
  const pending = new Map()
  let id = 0
  createInterface({ input: proc.stdout }).on('line', (line) => {
    const msg = JSON.parse(line)
    pending.get(msg.id)?.(msg)
    pending.delete(msg.id)
  })
  const request = (method, params) =>
    new Promise((resolve) => {
      pending.set(++id, resolve)
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return {
    init: async () => {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'docs-gifs', version: '1' } })
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    },
    call: async (name, args) => {
      const res = await request('tools/call', { name, arguments: args })
      const text = res.result?.content?.[0]?.text ?? '{}'
      if (res.result?.isError) throw new Error(`${name}: ${text}`)
      if (process.env.VVPOST_GIFS_DEBUG) console.error(name, text.slice(0, 400))
      return JSON.parse(text)
    },
    close: () => proc.kill()
  }
}

const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(rootUser ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
  env: { ...process.env, VVPOST_MCP_PORT: '0' }
})
const agent = mcp()
try {
  await agent.init()
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height])
  const nav = win.getByRole('navigation', { name: 'Módulos', exact: true })
  await nav.waitFor()
  const panel = win.locator('main > div:not([hidden])')
  const bar = win.getByRole('tablist', { name: 'Abas do workspace' })
  const tree = win.getByRole('tree', { name: 'Arquivos do projeto' })
  const module = (name) => nav.getByRole('button', { name, exact: true }).click()
  const wait = (ms) => win.waitForTimeout(ms)
  const explorer = async () => {
    if (!(await tree.isVisible())) await win.keyboard.press('Control+Shift+E')
    await tree.waitFor()
  }
  const noExplorer = async () => {
    if (await tree.isVisible()) await win.keyboard.press('Control+Shift+E')
    await tree.waitFor({ state: 'hidden' })
  }
  const openFile = async (name) => {
    await explorer()
    await tree.getByRole('button', { name, exact: true }).click()
    await bar.getByRole('tab', { name, exact: true }).waitFor()
  }

  // Grava quadros da janela enquanto fn roda (cada quadro dura até o próximo) e monta o GIF.
  const record = async (name, prepare, fn) => {
    if (only.size && !only.has(name)) return
    await prepare()
    await wait(800)
    const frames = []
    let recording = true
    const loop = (async () => {
      while (recording) {
        // A janela visível: a prévia do PDF monta numa janela escondida. Um quadro que a GPU não
        // entregou só fica de fora.
        const jpg = await app
          .evaluate(async ({ BrowserWindow }) =>
            (await BrowserWindow.getAllWindows().find((w) => w.isVisible()).webContents.capturePage()).toJPEG(92).toString('base64')
          )
          .catch(() => null)
        if (jpg) frames.push({ at: Date.now(), jpg })
        await new Promise((r) => setTimeout(r, 60))
      }
    })()
    try {
      await fn()
      await wait(2500)
    } catch (err) {
      if (process.env.VVPOST_GIFS_DEBUG) await win.screenshot({ path: join(out, `${name}-erro.png`) })
      throw err
    } finally {
      recording = false
      await loop
    }
    const dir = mkdtempSync(join(tmpdir(), `vvpost-gif-${name}-`))
    let list = ''
    frames.forEach((f, i) => {
      writeFileSync(join(dir, `${i}.jpg`), Buffer.from(f.jpg, 'base64'))
      const next = frames[i + 1]?.at ?? f.at + 2500
      list += `file '${i}.jpg'\nduration ${((next - f.at) / 1000).toFixed(3)}\n`
    })
    list += `file '${frames.length - 1}.jpg'\n`
    writeFileSync(join(dir, 'frames.txt'), list)
    const input = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt')]
    const scale = `fps=10,scale=${gifWidth}:-1:flags=lanczos`
    const ff = (args) => {
      const r = spawnSync('ffmpeg', args, { stdio: 'inherit' })
      if (r.status !== 0) throw new Error(`ffmpeg falhou em ${name}`)
    }
    const file = join(out, `${name}.${format}`)
    if (format === 'webp') ff([...input, '-vf', scale, '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', '80', '-loop', '0', file])
    else ff([...input, '-vf', `${scale},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, file])
    rmSync(dir, { recursive: true, force: true })
    console.log(file, `${frames.length} quadros`)
  }

  // Legenda com as chamadas que o agente faz pelo MCP, por cima da janela, para a cena contar
  // quem está mexendo no documento. As linhas são as chamadas e respostas reais.
  const caption = (lines) =>
    win.evaluate((lines) => {
      let box = document.getElementById('docs-gif-caption')
      if (!box) {
        box = document.createElement('div')
        box.id = 'docs-gif-caption'
        Object.assign(box.style, {
          position: 'fixed', right: '20px', bottom: '36px', width: '440px', zIndex: '99999', padding: '12px 14px',
          background: 'rgba(17,20,26,0.96)', border: '1px solid #8b7cff', borderRadius: '8px',
          font: '12px/1.6 "JetBrains Mono", ui-monospace, monospace', color: '#e7eaf0', whiteSpace: 'pre-wrap'
        })
        document.body.append(box)
      }
      box.textContent = ['Agente · MCP do VVPost', ...lines].join('\n')
    }, lines)
  const clearCaption = () => win.evaluate(() => document.getElementById('docs-gif-caption')?.remove())

  // O agente documenta um endpoint pelo MCP e o guia aberto no app se atualiza sozinho.
  await record(
    'mcp-agente',
    async () => {
      await openFile('guia-de-integracao.md')
      await panel.getByText('Lado a lado').click()
      await panel.getByRole('heading', { name: /POST \/charges/ }).first().waitFor()
      await noExplorer()
    },
    async () => {
      const log = []
      const step = async (line, fn) => {
        log.push(`→ ${line}`)
        await caption(log)
        await wait(900)
        const done = await fn()
        log.push(`  ✓ ${done}`)
        await caption(log)
        await wait(1200)
      }
      await step('find_references { terms: ["get_charge"] }', async () => {
        const r = await agent.call('find_references', { terms: ['get_charge'] })
        return r.count ? `${r.count} referência: ${r.matches[0].file}` : 'nenhuma referência'
      })
      await step('write_docs_page { file: "docs/guia-de-integracao.md", edits }', async () => {
        const r = await agent.call('write_docs_page', {
          file: 'docs/guia-de-integracao.md',
          edits: [{ find: '## Erros comuns', replace: '## Consultar uma cobrança\n\n{{> endpoint connector.payments.v1/get_charge}}\n\n## Erros comuns' }]
        })
        const errors = r.document?.errors ?? r.document?.diagnostics?.length ?? 0
        return `gravado · documento com ${errors} erros`
      })
      // A aba aberta relê o arquivo que o agente gravou.
      await panel.getByRole('heading', { name: /GET \/charges/ }).first().waitFor({ timeout: 15_000 })
      await panel.getByRole('heading', { name: /GET \/charges/ }).first().scrollIntoViewIfNeeded()
      await step('export_docs { format: "pdf" }', async () => {
        const r = await agent.call('export_docs', { format: 'pdf' })
        return `${r.file} · ${r.pages} páginas`
      })
    }
  )
  await clearCaption()

  // Prévia, texto e os dois lado a lado no mesmo .md, com a prévia acompanhando a digitação.
  await record(
    'previa-raw',
    async () => {
      await openFile('projeto.md')
      await panel.getByText('Prévia viva').click()
      await noExplorer()
    },
    async () => {
      await wait(1200)
      await panel.getByText('Raw', { exact: true }).click()
      await wait(1500)
      await panel.getByText('Lado a lado', { exact: true }).click()
      await panel.locator('.monaco-editor').waitFor()
      await wait(1200)
      await panel.locator('.monaco-editor .view-lines').first().click()
      await win.keyboard.press('Control+Home')
      await win.keyboard.press('End')
      await win.keyboard.press('Enter')
      await win.keyboard.press('Enter')
      await win.keyboard.type('Documentação mantida junto com o código, no mesmo repositório.', { delay: 35 })
      await wait(1500)
      await win.keyboard.press('Control+Z')
    }
  )

  // O editor do documento: o Markdown de um lado e o PDF do outro, remontado ao digitar.
  await record(
    'documentacao-pdf',
    async () => {
      await module('Documentação')
      await panel.getByRole('radio', { name: 'Editor' }).click()
      const editor = panel.getByRole('region', { name: 'Editor da documentação do projeto' })
      await editor.getByText('Lado a lado', { exact: true }).click()
      await editor.locator('[data-testid="pdf-pages"] canvas').nth(2).waitFor({ timeout: 60_000 })
      // A página do contexto do sistema, onde o texto digitado aparece.
      await editor.locator('[data-testid="pdf-pages"] canvas').nth(1).evaluate((c) => c.scrollIntoView({ block: 'start' }))
    },
    async () => {
      const editor = panel.getByRole('region', { name: 'Editor da documentação do projeto' })
      await editor.locator('.monaco-editor .view-lines').first().click()
      await win.keyboard.press('Control+Home')
      await win.keyboard.press('End')
      await win.keyboard.press('Enter')
      await win.keyboard.press('Enter')
      await win.keyboard.type('Versão revisada pelo time de pagamentos.', { delay: 35 })
      await wait(800)
      await win.keyboard.press('Control+Enter')
      await wait(3000)
      await win.keyboard.press('Control+Z')
    }
  )

  // A requisição é um fluxo: envia na visão Simples, com o passo anterior rodando antes, e troca
  // para o Canvas do mesmo documento.
  await record(
    'requisicao-canvas',
    async () => {
      await explorer()
      await tree.getByRole('button', { name: 'Cobrança PIX' }).click()
      await panel.getByText(/Antes: Cliente/).first().waitFor()
      await noExplorer()
    },
    async () => {
      await panel.getByRole('button', { name: 'Enviar' }).first().click()
      await panel.locator('text=201 Created >> visible=true').first().waitFor()
      await wait(1800)
      await panel.getByRole('radiogroup', { name: 'Visão do documento' }).getByRole('radio', { name: 'Canvas' }).click()
      await panel.getByTestId('flow-node-Cobranca').waitFor()
      await wait(1500)
      await panel.getByTestId('flow-node-Cobranca').click()
    }
  )
} finally {
  agent.close()
  await app.close()
  server.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(dirname(workspace), { recursive: true, force: true })
}
