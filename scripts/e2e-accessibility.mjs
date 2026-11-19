#!/usr/bin/env node
// Critérios de aceite do design system no app real: medidas do
// shell, navegação só por teclado (Ctrl+K, Ctrl+1..N, Tab), foco visível em todo controle
// alcançável, contraste do texto renderizado (WCAG AA, 4,5:1) e escala de fonte (zoom de 125% e
// 150%) sem rolagem horizontal nem controles fora da janela, em todos os módulos.
// Uso: npm run build && node scripts/e2e-accessibility.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const json = (v) => `${JSON.stringify(v, null, 2)}\n`

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-a11y-ws-'))
mkdirSync(join(workspace, 'environments'))
writeFileSync(
  join(workspace, 'environments/dev.env.json'),
  json({
    id: 'env.dev',
    name: 'Development',
    variables: {
      BASE_URL: { type: 'string', value: 'http://localhost' },
      API_TOKEN: { type: 'string', value: '__REQUIRED_SECRET__', isSecret: true }
    }
  })
)
const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
writeFileSync(join(userData, 'workspace.json'), json({ dir: workspace }))

const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})

/** Texto visível com contraste abaixo de 4,5:1 contra o fundo efetivo (fundos translúcidos compostos). */
function lowContrastTexts() {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const [r, g, b, a = '1'] = m[1].split(/[\s,/]+/).filter(Boolean)
    return [Number(r), Number(g), Number(b), Number(a)]
  }
  const over = (top, bottom) => {
    const a = top[3]
    return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1)
  }
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const background = (el) => {
    const layers = []
    for (let node = el; node; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor)
      if (bg && bg[3] > 0) {
        layers.push(bg)
        if (bg[3] === 1) break
      }
    }
    return layers.reduceRight((acc, layer) => over(layer, acc), [11, 12, 15, 1])
  }
  const dimmed = (el) => {
    for (let node = el; node; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) < 1) return true
      if (node.matches?.(':disabled, [aria-disabled="true"]')) return true
    }
    return false
  }
  const failures = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const el = text.parentElement
    if (!el || !text.textContent.trim() || !el.checkVisibility?.() || dimmed(el)) continue
    if (el.closest('[aria-hidden="true"], .react-flow__renderer')) continue
    const style = getComputedStyle(el)
    const fg = parse(style.color)
    if (!fg) continue
    const bg = background(el)
    const [hi, lo] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x)
    const ratio = (hi + 0.05) / (lo + 0.05)
    const large =
      parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700)
    if (ratio < (large ? 3 : 4.5)) failures.push(`${ratio.toFixed(2)}:1 "${text.textContent.trim().slice(0, 40)}"`)
  }
  return [...new Set(failures)]
}

try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  const nav = win.getByRole('navigation', { name: 'Módulos' })
  await nav.waitFor()
  const modules = await nav
    .locator('button[data-panel]')
    .evaluateAll((els) => els.map((b) => b.getAttribute('aria-label')))
  const shortcuts = await nav
    .locator('button[data-panel]')
    .evaluateAll((els) => els.map((b) => b.getAttribute('aria-keyshortcuts')))
  assert.ok(modules.length >= 5, `módulos na sidebar: ${modules}`)
  const panel = win.locator('main > div:not([hidden])')

  // Medidas do shell (seção 3): sidebar fixa de 48 px, barra superior de 44 a 48, status de 24.
  const box = async (selector) => win.locator(selector).first().boundingBox()
  assert.equal((await box('nav[aria-label="Módulos"]')).width, 48)
  // Expandida: rótulos e grupos por intenção.
  await nav.getByRole('button', { name: 'Expandir a navegação' }).click()
  assert.equal((await box('nav[aria-label="Módulos"]')).width, 208)
  assert.deepEqual(
    await nav.locator('[role="group"]').evaluateAll((els) => els.map((g) => g.getAttribute('aria-label'))),
    ['Trabalho', 'Projeto', 'Integrações']
  )
  assert.ok(await nav.getByText(modules[0], { exact: true }).isVisible(), 'rótulo visível na sidebar expandida')
  await nav.getByRole('button', { name: 'Recolher a navegação' }).click()
  assert.equal((await box('nav[aria-label="Módulos"]')).width, 48)
  const top = await win.evaluate(() => document.querySelector('header')?.getBoundingClientRect().height)
  assert.ok(top >= 44 && top <= 48, `barra superior com ${top} px`)
  const status = await win.evaluate(() => document.querySelector('footer')?.getBoundingClientRect().height)
  assert.equal(status, 24)
  // Sem --ux-study, nada é gravado nem anunciado.
  assert.equal(await win.locator('footer').getByText('Estudo de UX gravando').count(), 0)
  assert.equal(await nav.locator('[role="tree"], ul ul').count(), 0, 'a sidebar não tem árvore de recursos')

  // Sem barra de título do sistema: a barra superior arrasta a janela e reserva o espaço dos
  // botões nativos (Window Controls Overlay), sem que eles cubram a busca.
  const titlebar = await win.evaluate(() => {
    const header = document.querySelector('header')
    const area = navigator.windowControlsOverlay?.getTitlebarAreaRect()
    const search = document.querySelector('button[aria-label="Buscar ou executar comando"]').getBoundingClientRect()
    return {
      overlay: navigator.windowControlsOverlay?.visible ?? false,
      drag: getComputedStyle(header).getPropertyValue('-webkit-app-region') || getComputedStyle(header).webkitAppRegion,
      searchClear: !area || (search.left >= area.x && search.right <= area.x + area.width)
    }
  })
  assert.deepEqual(titlebar, { overlay: true, drag: 'drag', searchClear: true })

  // Teclado: o atalho anunciado de cada módulo (aria-keyshortcuts, dígito fixo mesmo com a
  // sidebar agrupada) abre o módulo, e a paleta (Ctrl+K) navega, fecha com Esc e devolve o foco.
  // Os dez dígitos têm dono; um módulo sem dígito (Documentação, MCP & IA, Configurações) abre pela
  // sidebar e pela paleta, e não anuncia atalho.
  const withKey = shortcuts.filter(Boolean)
  assert.equal(new Set(withKey).size, withKey.length, `atalhos repetidos: ${shortcuts}`)
  assert.equal(withKey.length, 10, `os dez dígitos deveriam ter módulo: ${shortcuts}`)
  for (const [i, label] of modules.entries()) {
    if (!shortcuts[i]) continue
    await win.keyboard.press(shortcuts[i])
    await nav.locator(`button[aria-label="${label}"][aria-current="page"]`).waitFor()
  }
  await win.keyboard.press('Control+1')
  await win.locator('body').focus()
  await win.keyboard.press('Control+k')
  const palette = win.getByRole('dialog', { name: 'Paleta de comandos' })
  await palette.waitFor()
  await win.keyboard.type(modules[1])
  await win.keyboard.press('Enter')
  await palette.waitFor({ state: 'hidden' })
  await nav.locator(`button[aria-label="${modules[1]}"][aria-current="page"]`).waitFor()
  await win.keyboard.press('Control+k')
  await palette.waitFor()
  await win.keyboard.press('Escape')
  await palette.waitFor({ state: 'hidden' })

  const report = []
  for (const [i, label] of modules.entries()) {
    await nav.getByRole('button', { name: label, exact: true }).click()
    await nav.locator(`button[aria-label="${label}"][aria-current="page"]`).waitFor()
    await panel.locator('*').first().waitFor()
    await win.waitForTimeout(150)

    // Foco: cada Tab cai num elemento visível com indicador de foco (outline do :focus-visible).
    await win.evaluate(() => document.activeElement?.blur())
    const noRing = new Set()
    const seen = new Set()
    for (let step = 0; step < 40; step++) {
      await win.keyboard.press('Tab')
      const info = await win.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body) return null
        const r = el.getBoundingClientRect()
        const name = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || el.tagName
        // O anel pode estar num invólucro com :focus-within (a URL do Quick Request, com a baseUrl ao lado).
        const ringed = (node) => {
          const s = getComputedStyle(node)
          return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'
        }
        const ring = ringed(el) || (!!el.parentElement && ringed(el.parentElement))
        return { name: `${el.tagName.toLowerCase()} "${name}"`, ring, visible: r.width > 0 && r.height > 0 }
      })
      if (!info) continue
      seen.add(info.name)
      if (!info.ring || !info.visible) noRing.add(info.name)
    }
    assert.ok(seen.size >= 5, `${label}: o Tab alcançou só ${[...seen]}`)
    assert.deepEqual([...noRing], [], `${label}: controles sem foco visível`)

    const contrast = await win.evaluate(lowContrastTexts)
    assert.deepEqual(contrast, [], `${label}: texto abaixo de 4,5:1`)
    report.push(`${label} (${seen.size} paradas de Tab)`)
    if (i === 0) {
      // A paleta também passa no contraste.
      await win.keyboard.press('Control+k')
      await palette.waitFor()
      assert.deepEqual(await win.evaluate(lowContrastTexts), [], 'paleta: texto abaixo de 4,5:1')
      await win.keyboard.press('Escape')
    }
  }

  // Escala de fonte: 125% e 150% sem rolagem horizontal e com shell e ações dentro da janela.
  for (const zoom of [1.25, 1.5]) {
    await app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(z), zoom)
    for (const label of modules) {
      await nav.getByRole('button', { name: label, exact: true }).click()
      await win.waitForTimeout(120)
      const layout = await win.evaluate(() => {
        const out = (el) => {
          const r = el.getBoundingClientRect()
          return r.right > innerWidth + 1 || r.bottom > innerHeight + 1
        }
        return {
          overflowX: document.documentElement.scrollWidth > innerWidth + 1,
          statusOut: out(document.querySelector('footer')),
          // A status bar fica numa linha só: um item quebrado em duas sai pela borda de baixo.
          statusWrapped: (() => {
            const footer = document.querySelector('footer')
            return [...footer.querySelectorAll('span, button')].some(
              (el) => el.getBoundingClientRect().bottom > footer.getBoundingClientRect().bottom + 1
            )
          })(),
          // Os módulos podem rolar dentro da navegação; cada um precisa ficar visível ao rolar até ele.
          navOut: [...document.querySelectorAll('nav[aria-label="Módulos"] button')].filter((b) => {
            b.scrollIntoView({ block: 'nearest' })
            return out(b)
          }).length
        }
      })
      assert.deepEqual(layout, { overflowX: false, statusOut: false, statusWrapped: false, navOut: 0 }, `${label} com zoom ${zoom}`)
      // O inspector nunca deixa o módulo com menos de 560 px; sem espaço, fica na faixa da direita
      // e abre como gaveta por cima do conteúdo (Ctrl+B), que o Esc fecha.
      const inspector = win.locator('main > div:not([hidden]) aside[data-inspector-mode]').first()
      if (await inspector.count()) {
        const room = () =>
          inspector.evaluate((a) => ({ mode: a.dataset.inspectorMode, content: a.parentElement.clientWidth - a.offsetWidth }))
        const before = await room()
        assert.ok(before.mode === 'rail' || before.content >= 560, `${label} com zoom ${zoom}: ${JSON.stringify(before)}`)
        if (zoom === 1.5) {
          assert.equal(before.mode, 'rail', `${label} com zoom 150%: inspector recolhido`)
          await win.keyboard.press('Control+b')
          const drawer = await room()
          assert.equal(drawer.mode, 'drawer', `${label}: Ctrl+B abre a gaveta`)
          assert.ok(drawer.content >= 560, `${label}: a gaveta não espreme o módulo`)
          await win.keyboard.press('Escape')
          assert.equal((await room()).mode, 'rail', `${label}: Esc fecha a gaveta`)
        }
      }
      if (label === 'Quick Request') {
        // Janela baixa: a faixa de contexto vira uma linha só, sem os rótulos acima dos campos.
        const strip = await win.evaluate(() => {
          const group = document.querySelector('[role="group"][aria-label="Contexto da requisição"]')
          return {
            short: innerHeight < 620,
            compact: group?.parentElement?.dataset.compact === 'true',
            height: group?.getBoundingClientRect().height ?? 0
          }
        })
        assert.equal(strip.compact, strip.short, `contexto compacto com zoom ${zoom}`)
        // Os seletores numa linha só, da altura de um campo (32 px), sem os rótulos em cima.
        if (strip.compact) assert.ok(strip.height <= 34, `seletores de contexto com ${strip.height}px em ${zoom}`)
      }
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))

  assert.deepEqual(errors, [])
  console.log(`E2E de acessibilidade: ok (${report.join(', ')}; zoom 125% e 150%)`)
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
