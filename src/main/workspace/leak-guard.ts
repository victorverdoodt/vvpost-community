import { validateConnector, validateFlow } from '@vvpost/schemas'
import { literalSecrets } from '@vvpost/core/connectors/edit'
import { literalFlowSecrets } from '@vvpost/core/flows/workspace'
import { readSecretsStore, type SecretsStore } from './vault'

/**
 * Valores locais mais curtos que isto não são procurados nos arquivos: "1234" ou
 * "true" apareceriam em qualquer JSON e bloqueariam commits sem motivo.
 */
export const MIN_KNOWN_SECRET_LENGTH = 6
/** Arquivo maior que isto não é conferido (não é configuração, é dado). */
const MAX_SCAN_BYTES = 5 * 1024 * 1024
const CONNECTOR_SUFFIX = '.connector.vvpost.json'
const FLOW_SUFFIX = '.flow.vvpost.json'

const connectorFields = (doc: unknown) => {
  const r = validateConnector(doc)
  return r.ok ? literalSecrets(r.value) : []
}
const flowFields = (doc: unknown) => {
  const r = validateFlow(doc)
  return r.ok ? literalFlowSecrets(r.value) : []
}
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

/** Um segredo achado num arquivo que iria para o Git. Nunca carrega o valor. */
export interface SecretLeak {
  file: string
  reason: string
}

/** As formas em que um valor costuma aparecer num arquivo: puro, em JSON, em URL, em form, em base64 e em hex. */
export function encodedForms(value: string): string[] {
  const base64 = Buffer.from(value).toString('base64')
  return [
    ...new Set([
      value,
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
      encodeURIComponent(value).replace(/%20/g, '+'),
      base64.replace(/=+$/, ''),
      Buffer.from(value).toString('base64url'),
      Buffer.from(value).toString('hex'),
      Buffer.from(value).toString('hex').toUpperCase()
    ])
  ]
}

/**
 * Confere o conteúdo que vai para o Git: nenhum valor de
 * .vvpost/secrets.local.json em nenhuma forma, nenhuma credencial literal num
 * conector ou fluxo e nenhuma chave privada PEM. `content` null é arquivo apagado.
 */
export async function findSecretLeaks(
  dir: string,
  files: { path: string; content: string | null }[],
  store?: SecretsStore
): Promise<SecretLeak[]> {
  const secrets = store ?? (await readSecretsStore(dir).catch((): SecretsStore => ({})))
  const known: { forms: string[]; label: string }[] = []
  for (const [envId, vars] of Object.entries(secrets)) {
    for (const [name, value] of Object.entries(vars ?? {})) {
      if (typeof value !== 'string' || value.length < MIN_KNOWN_SECRET_LENGTH) continue
      known.push({ forms: encodedForms(value), label: `o valor do segredo ${name} do ambiente ${envId}` })
    }
  }

  const leaks: SecretLeak[] = []
  for (const { path, content } of files) {
    if (content === null || content.length > MAX_SCAN_BYTES || content.includes('\0')) continue
    for (const k of known) {
      if (k.forms.some((f) => content.includes(f))) leaks.push({ file: path, reason: k.label })
    }
    if (PRIVATE_KEY.test(content)) leaks.push({ file: path, reason: 'uma chave privada PEM' })
    if (path.endsWith(CONNECTOR_SUFFIX) || path.endsWith(FLOW_SUFFIX)) {
      let doc: unknown
      try {
        doc = JSON.parse(content)
      } catch {
        continue
      }
      const fields = path.endsWith(FLOW_SUFFIX) ? flowFields(doc) : connectorFields(doc)
      for (const field of fields) leaks.push({ file: path, reason: `credencial literal em ${field}` })
    }
  }
  return leaks
}

/** Mensagem do commit recusado: arquivo e motivo, sem o valor. */
export function describeLeaks(leaks: SecretLeak[]): string {
  const lines = leaks.slice(0, 5).map((l) => `${l.file}: ${l.reason}`)
  if (leaks.length > 5) lines.push(`e mais ${leaks.length - 5}`)
  return (
    `Commit bloqueado: segredo em arquivo versionado.\n${lines.join('\n')}\n` +
    'Troque o valor por uma variável {{NOME}} de um ambiente, marcada como segredo, ou tire o arquivo do commit.'
  )
}
