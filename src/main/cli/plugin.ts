import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { extractArchive, writeZip } from '@vvpost/core/plugins/archive'
import { readManifest } from '@vvpost/core/plugins/manager'
import { sha256Hex } from '@vvpost/core/plugins/registry'
import { generateSigningKey, listPluginFiles, signPluginDir, SIGNATURE_FILE, verifyPluginDir } from '@vvpost/core/plugins/signature'
import type { Io } from './index'

/**
 * `vvpost plugin`: ferramentas de quem publica plugins (docs/plugins.md, "Publicar").
 * keygen cria a chave Ed25519, sign grava vvpost-plugin.sig.json, pack gera o .zip (assinando
 * antes, com --key) e mostra a entrada do registro, verify confere uma pasta ou um pacote.
 */

export const PLUGIN_HELP = `Uso: vvpost plugin <subcomando>

  keygen --out <arquivo.key>          Cria uma chave de assinatura Ed25519 (a privada vai para o arquivo)
  sign <pasta> --key <arquivo.key>    Assina o plugin: grava ${SIGNATURE_FILE} com o hash de cada arquivo
  pack <pasta> [--key <arquivo.key>] [--out <arquivo.zip>]
                                      Gera o pacote .zip (assinando antes, com --key) e mostra o SHA-256
                                      e a entrada para o vvpost-registry.json
  verify <pasta|pacote>               Confere a assinatura; sai com 0 se ela for válida, 1 se não houver ou não conferir
`

const MAX = { maxFiles: 5_000, maxBytes: 100 * 1024 * 1024 }

async function manifestOf(dir: string) {
  const read = await readManifest(dir)
  if ('error' in read) throw new Error(`${dir}: ${read.error}`)
  return read.manifest
}

export async function pluginCommand(io: Io, args: string[], values: { key?: string; out?: string; json?: string }): Promise<number> {
  const [sub, target] = args
  const path = (p: string) => resolve(io.cwd, p)
  try {
    if (sub === 'keygen') {
      if (!values.out) throw new Error('keygen: informe --out <arquivo.key>')
      const key = generateSigningKey()
      await writeFile(path(values.out), key.privateKeyPem, { mode: 0o600, flag: 'wx' })
      io.stdout(`Chave privada: ${path(values.out)} (guarde fora do repositório)\nChave pública: ${key.publicKey}\nImpressão digital: ${key.fingerprint}\n`)
      return 0
    }
    if (sub === 'sign' || sub === 'pack') {
      if (!target) throw new Error(`${sub}: informe a pasta do plugin`)
      const dir = path(target)
      const manifest = await manifestOf(dir)
      if (sub === 'sign' && !values.key) throw new Error('sign: informe --key <arquivo.key>')
      if (values.key) {
        const signature = await signPluginDir(dir, await readFile(path(values.key), 'utf8'), manifest)
        await writeFile(join(dir, SIGNATURE_FILE), `${JSON.stringify(signature, null, 2)}\n`)
        io.stderr(`Assinado: ${manifest.id}@${manifest.version}, ${Object.keys(signature.files).length} arquivos\n`)
      }
      if (sub === 'sign') return 0
      const signed = await verifyPluginDir(dir, manifest)
      if (signed.status === 'invalid') throw new Error(`a assinatura da pasta não confere (${signed.reason}); assine de novo com --key`)
      const files = await listPluginFiles(dir)
      if (signed.status === 'valid') files.push(SIGNATURE_FILE)
      const zip = writeZip(await Promise.all(files.map(async (rel) => ({ path: rel, data: await readFile(join(dir, ...rel.split('/'))) }))))
      const out = path(values.out ?? `${manifest.id}-${manifest.version}.zip`)
      await writeFile(out, zip)
      const sha256 = sha256Hex(zip)
      const entry = { version: manifest.version, url: basename(out), sha256, ...(signed.status === 'valid' && { publicKey: signed.publicKey }) }
      io.stdout(
        `Pacote: ${out} (${files.length} arquivos, ${Math.max(1, Math.round(zip.length / 1024))} KB)\nSHA-256: ${sha256}\n` +
          `${signed.status === 'valid' ? `Assinatura: ${signed.fingerprint}` : 'Sem assinatura (use --key)'}\n` +
          `Entrada em plugins[].versions do vvpost-registry.json:\n${JSON.stringify(entry, null, 2)}\n`
      )
      return 0
    }
    if (sub === 'verify') {
      if (!target) throw new Error('verify: informe a pasta ou o pacote')
      const source = path(target)
      let dir = source
      let temp: string | undefined
      if (!(await stat(source)).isDirectory()) {
        temp = await mkdtemp(join(tmpdir(), 'vvpost-plugin-'))
        dir = await extractArchive(source, temp, MAX)
      }
      try {
        const manifest = await manifestOf(dir)
        const check = await verifyPluginDir(dir, manifest)
        if (values.json === '-') io.stdout(`${JSON.stringify({ id: manifest.id, version: manifest.version, ...check })}\n`)
        else if (check.status === 'valid') io.stdout(`${manifest.id}@${manifest.version}: assinatura válida (${check.fingerprint})\n`)
        else if (check.status === 'unsigned') io.stdout(`${manifest.id}@${manifest.version}: sem assinatura\n`)
        else io.stdout(`${manifest.id}@${manifest.version}: assinatura inválida: ${check.reason}\n`)
        return check.status === 'valid' ? 0 : 1
      } finally {
        if (temp) await rm(temp, { recursive: true, force: true })
      }
    }
    io.stderr(sub ? `vvpost plugin: subcomando desconhecido "${sub}"\n\n${PLUGIN_HELP}` : PLUGIN_HELP)
    return 2
  } catch (err) {
    io.stderr(`vvpost plugin: ${(err as Error).message}\n`)
    return 2
  }
}
