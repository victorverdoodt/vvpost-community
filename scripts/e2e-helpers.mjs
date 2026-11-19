// Ajuda dos E2E: o conector como o workspace o dá, esteja ele num .connector.vvpost.json ou
// em fluxos (um fluxo-base e um fluxo de requisição por endpoint). Lê pelo pacote do CLI
// (out/main/cli.js), que exporta cada conector com endpoints e cenários, sem segredo.
import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cliJs = join(dirname(fileURLToPath(import.meta.url)), '..', 'out/main/cli.js')

/** Os conectores do workspace, pelo id. */
export function connectorsOf(workspace) {
  const bundle = JSON.parse(execFileSync(process.execPath, [cliJs, 'export', '--workspace', workspace, '--out', '-'], { encoding: 'utf8' }))
  return Object.fromEntries((bundle.connectors ?? []).map((c) => [c.id, c]))
}

/** Um conector do workspace; falha se não existir. */
export function connectorOf(workspace, id) {
  const connector = connectorsOf(workspace)[id]
  if (!connector) throw new Error(`conector "${id}" não está no workspace ${workspace}`)
  return connector
}

/**
 * O cofre local de uma pasta (@vvpost/core/vault), aberto aqui com a chave em arquivo que os E2E
 * usam (scripts/e2e-all.mjs: VVPOST_VAULT_DIR e VVPOST_VAULT_KEYSTORE=file). Lê o formato por
 * fora do app, para o teste conferir o que ficou gravado.
 */
export function readVault(workspace) {
  const dir = process.env.VVPOST_VAULT_DIR
  if (!dir) throw new Error('VVPOST_VAULT_DIR não definido: rode pelo npm run test:e2e')
  // O nativo, como o fs.promises.realpath do cofre: no Windows expande o caminho curto (RUNNER~1).
  const id = createHash('sha256').update(realpathSync.native(workspace)).digest('hex').slice(0, 32)
  const file = join(dir, `${id}.vault.json`)
  if (!existsSync(file)) return {}
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const key = Buffer.from(readFileSync(join(dir, 'vault.key'), 'utf8').trim(), 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(doc.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(doc.tag, 'base64'))
  decipher.setAAD(Buffer.from(`vvpost-vault:${doc.dir}`))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(doc.data, 'base64')), decipher.final()]).toString('utf8'))
}
