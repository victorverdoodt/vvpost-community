#!/usr/bin/env node
// Teste ponta a ponta do editor visual dos campos do corpo no app real (build de produção em out/):
// um endpoint escrito à mão, sem OpenAPI e sem schema, ganha os campos pela documentação dele no
// Catálogo (gerados do corpo padrão e ajustados: obrigatório, enum, descrição, objeto aninhado),
// o arquivo grava o bodySchema, a tabela de campos aparece e o Quick Request abre o formulário
// tipado com eles. O editor do conector mostra os mesmos campos na visão Campos. Dois endpoints que
// citam o mesmo schema compartilhado (schemas/Pedido.schema.json) mudam juntos: editar os campos de
// um grava o schema, e a tabela do outro mostra o campo novo.
// Uso: npm run build && node scripts/e2e-schema-builder.mjs   (Linux sem display: xvfb-run -a)
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = createRequire(import.meta.url)('electron')
const screenshot = process.env.E2E_SCREENSHOT

const workspace = mkdtempSync(join(tmpdir(), 'vvpost-workspace-'))
const file = join(workspace, 'connectors/loja.connector.vvpost.json')
mkdirSync(dirname(file), { recursive: true })
writeFileSync(
  file,
  JSON.stringify(
    {
      id: 'connector.loja',
      name: 'Loja',
      version: '1.0.0',
      config: { baseUrl: 'http://127.0.0.1:9' },
      endpoints: [
        { id: 'criar_pedido', name: 'Criar pedido', method: 'POST', path: '/pedidos', body: { produto: 'caneca', quantidade: 1, entrega: 'normal' } },
        { id: 'trocar_pedido', name: 'Trocar pedido', method: 'PUT', path: '/pedidos/{id}', bodySchema: { $ref: 'schema:Pedido' } },
        { id: 'copiar_pedido', name: 'Copiar pedido', method: 'POST', path: '/pedidos/{id}/copia', bodySchema: { $ref: 'schema:Pedido' } }
      ]
    },
    null,
    2
  )
)
const schemaPath = join(workspace, 'schemas/Pedido.schema.json')
mkdirSync(dirname(schemaPath), { recursive: true })
writeFileSync(schemaPath, JSON.stringify({ type: 'object', properties: { total: { type: 'number' } } }, null, 2))

const userData = mkdtempSync(join(tmpdir(), 'vvpost-e2e-'))
const app = await _electron.launch({
  executablePath: electronBin,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root]
})
try {
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (e) => errors.push(e.message))
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, workspace)

  await win.getByRole('button', { name: 'Catálogo' }).click()
  const panel = win.locator('main > div:not([hidden])')
  await panel.getByRole('button', { name: 'Abrir workspace…' }).click()
  await panel.getByRole('navigation', { name: 'Hierarquia de conectores' }).getByRole('button', { name: /Loja/ }).click()
  await panel.getByRole('tab', { name: 'Documentação' }).click()
  const endpoint = panel.getByRole('region', { name: 'Endpoint Criar pedido' })
  await endpoint.getByRole('button', { name: 'Definir os campos do corpo' }).click()

  // Gerado do corpo padrão; depois o ajuste fino, campo a campo.
  const fields = endpoint.getByRole('group', { name: 'Campos do corpo de Criar pedido' })
  await fields.getByRole('button', { name: 'Gerar do corpo padrão' }).click()
  assert.equal(await fields.getByLabel('Tipo de quantidade').inputValue(), 'integer')
  await fields.getByLabel('produto obrigatório').check()
  await fields.getByLabel('Descrição de produto').fill('Nome do produto')
  await fields.getByLabel('quantidade obrigatório').check()
  await fields.getByRole('button', { name: 'Mais opções de quantidade' }).click()
  await fields.getByLabel('mínimo de quantidade').fill('1')
  await fields.getByRole('button', { name: 'Mais opções de entrega' }).click()
  await fields.getByLabel('Valores aceitos de entrega').fill('normal, expressa')
  await fields.getByLabel('Valores aceitos de entrega').press('Enter')
  // Objeto aninhado: campo novo, vira objeto e ganha um campo dentro.
  await fields.getByRole('button', { name: 'Adicionar campo', exact: true }).click()
  await fields.getByLabel('Nome do campo campo4').fill('cliente')
  await fields.getByLabel('Nome do campo campo4').press('Enter')
  await fields.getByLabel('Tipo de cliente').selectOption('object')
  await fields.getByRole('button', { name: 'Adicionar campo em cliente' }).click()
  await fields.getByLabel('Nome do campo cliente.campo1').fill('email')
  await fields.getByLabel('Nome do campo cliente.campo1').press('Enter')
  await fields.getByRole('button', { name: 'Mais opções de cliente.email' }).click()
  await fields.getByLabel('Formato de cliente.email').selectOption('email')
  await fields.getByLabel('cliente.email obrigatório').check()
  if (screenshot) await win.screenshot({ path: screenshot.replace(/\.png$/, '-editor.png') })
  await endpoint.getByRole('button', { name: 'Salvar os campos' }).click()

  // O arquivo grava o JSON Schema, e a documentação mostra a tabela de campos.
  const table = endpoint.getByRole('table', { name: 'Campos do corpo de Criar pedido' })
  await table.getByText('Nome do produto').waitFor()
  const saved = JSON.parse(readFileSync(file, 'utf8')).endpoints[0]
  assert.deepEqual(saved.bodySchema, {
    type: 'object',
    properties: {
      produto: { type: 'string', description: 'Nome do produto' },
      quantidade: { type: 'integer', minimum: 1 },
      entrega: { type: 'string', enum: ['normal', 'expressa'] },
      cliente: { type: 'object', properties: { email: { type: 'string', format: 'email' } }, required: ['email'] }
    },
    required: ['produto', 'quantidade']
  })
  await endpoint.getByText('corpos de acordo com o schema').waitFor()

  // Schema compartilhado: editar os campos de um endpoint muda o arquivo do schema, e o outro vê.
  const trocar = panel.getByRole('region', { name: 'Endpoint Trocar pedido' })
  await trocar.getByRole('button', { name: 'Editar os campos do corpo' }).click()
  await trocar.getByText('Schema compartilhado').waitFor()
  await trocar.getByText(/a mudança vale para os 2 usos/).waitFor()
  await trocar.getByRole('group', { name: 'Campos do corpo de Trocar pedido' }).getByLabel('Descrição de total').fill('Valor total do pedido')
  await trocar.getByRole('button', { name: 'Salvar os campos' }).click()
  const copiar = panel.getByRole('region', { name: 'Endpoint Copiar pedido' })
  await copiar.getByRole('table', { name: 'Campos do corpo de Copiar pedido' }).getByText('Valor total do pedido').waitFor()
  assert.equal(JSON.parse(readFileSync(schemaPath, 'utf8')).properties.total.description, 'Valor total do pedido')
  const refs = JSON.parse(readFileSync(file, 'utf8')).endpoints.slice(1).map((e) => e.bodySchema)
  assert.deepEqual(refs, [{ $ref: 'schema:Pedido' }, { $ref: 'schema:Pedido' }])

  // O editor do conector mostra os mesmos campos.
  await panel.getByRole('tab', { name: 'Editar' }).click()
  await panel.getByRole('button', { name: /Criar pedido/ }).first().click()
  const editorFields = panel.getByRole('group', { name: 'Campos do corpo de Criar pedido' })
  assert.equal(await editorFields.getByLabel('Tipo de cliente', { exact: true }).inputValue(), 'object')
  assert.equal(await editorFields.getByLabel('produto obrigatório').isChecked(), true)

  // Quick Request: o endpoint abre o Body como formulário tipado com os campos definidos.
  await win.getByRole('button', { name: 'Quick Request' }).click()
  await win.selectOption('select[aria-label="Conector"]', 'connector.loja')
  await win.selectOption('select[aria-label="Endpoint"]', 'criar_pedido')
  await win.getByRole('tab', { name: /^Body/ }).click()
  const form = win.getByRole('group', { name: 'Formulário do corpo' })
  await form.getByLabel('entrega', { exact: true }).waitFor()
  assert.deepEqual(await form.getByLabel('entrega', { exact: true }).locator('option').allTextContents(), ['(não enviar)', 'normal', 'expressa'])
  await form.getByText('Nome do produto').waitFor()

  assert.deepEqual(errors, [])
  console.log('e2e-schema-builder: ok')
} finally {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
