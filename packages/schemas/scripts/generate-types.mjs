// Gera src/types/*.ts a partir de schemas/*.json.
// Com --check, não escreve nada e falha se os tipos commitados estiverem desatualizados.
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { compile } from 'json-schema-to-typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const check = process.argv.includes('--check')

const targets = [
  { schema: 'connector.json', out: 'connector.ts' },
  { schema: 'environment.json', out: 'environment.ts' },
  { schema: 'secrets-engine.json', out: 'secrets-engine.ts' },
  { schema: 'flow.json', out: 'flow.ts' },
  { schema: 'plugin.json', out: 'plugin.ts' },
  { schema: 'bundle.json', out: 'bundle.ts' },
  { schema: 'webhooks.json', out: 'webhooks.ts' },
  { schema: 'privacy.json', out: 'privacy.ts' },
  { schema: 'project.json', out: 'project.ts' },
  { schema: 'docs.json', out: 'docs.ts' },
  { schema: 'publish.json', out: 'publish.ts' },
  { schema: 'workspace-plugins.json', out: 'workspace-plugins.ts' }
]

const banner = `/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */`

// if/then/else não tem equivalente em tipos estáticos; sem esta limpeza o gerador
// transforma cada allOf condicional em interseções sem sentido (Foo = Foo1 & Foo1).
// As regras continuam valendo na validação em runtime.
const conditional = new Set(['if', 'then', 'else'])
function stripConditionals(node) {
  if (Array.isArray(node)) return node.map(stripConditionals)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'allOf' && value.every((s) => Object.keys(s).every((k) => conditional.has(k)))) continue
    if (conditional.has(key)) continue
    out[key] = stripConditionals(value)
  }
  return out
}

// Um $ref para outro schema (o fluxo reusa partes do conector) leva tsType ao lado:
// o tipo vem de lá, e o gerador não tenta buscar a URL.
function stripExternalRefs(node) {
  if (Array.isArray(node)) return node.map(stripExternalRefs)
  if (!node || typeof node !== 'object') return node
  if (node.tsType && (typeof node.$ref === 'string' && !node.$ref.startsWith('#') || node.oneOf?.some((s) => s.$ref && !s.$ref.startsWith('#')))) {
    const { $ref: _ref, oneOf: _oneOf, ...rest } = node
    return rest
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, stripExternalRefs(v)]))
}

let stale = 0
for (const { schema, out } of targets) {
  const json = JSON.parse(await readFile(`${root}schemas/${schema}`, 'utf8'))
  const ts = await compile(stripExternalRefs(stripConditionals(json)), json.title, {
    bannerComment: banner,
    additionalProperties: false,
    unreachableDefinitions: false,
    style: { semi: false, singleQuote: true, printWidth: 100, trailingComma: 'none' }
  })
  const path = `${root}src/types/${out}`
  if (check) {
    const current = await readFile(path, 'utf8').catch(() => '')
    if (current !== ts) {
      console.error(`desatualizado: src/types/${out} (rode npm run generate)`)
      stale++
    }
  } else {
    await writeFile(path, ts)
    console.log(`gerado: src/types/${out}`)
  }
}
if (stale) process.exit(1)
