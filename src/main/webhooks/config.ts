import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateWebhooksConfig, type WebhookHook } from '@vvpost/schemas'
import type { WebhookHookInfo } from '@shared/ipc'
import { DEFAULT_MAX_EVENTS } from './inbox'

export const WEBHOOKS_FILE = '.vvpost/webhooks.json'
export const DEFAULT_WEBHOOK_PORT = 4480
const DEFAULT_MAX_BODY_KB = 1024

export interface ResolvedWebhooksConfig {
  /** O arquivo existe no workspace. */
  file: boolean
  port: number
  /** Ambiente das assinaturas e dos disparos, como está no arquivo; null: o primeiro do workspace. */
  environment: string | null
  allowHosts: string[]
  maxEvents: number
  maxBodyBytes: number
  hooks: WebhookHook[]
}

/** Lê e valida .vvpost/webhooks.json; sem o arquivo, o servidor aceita tudo com os padrões. */
export async function loadWebhooksConfig(dir: string): Promise<ResolvedWebhooksConfig> {
  let text: string
  try {
    text = await readFile(join(dir, WEBHOOKS_FILE), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return { file: false, port: DEFAULT_WEBHOOK_PORT, environment: null, allowHosts: [], maxEvents: DEFAULT_MAX_EVENTS, maxBodyBytes: DEFAULT_MAX_BODY_KB * 1024, hooks: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`${WEBHOOKS_FILE}: JSON inválido (${(err as Error).message})`)
  }
  const check = validateWebhooksConfig(parsed)
  if (!check.ok) {
    throw new Error(`${WEBHOOKS_FILE} inválido: ${check.issues.slice(0, 3).map((i) => `${i.path || '/'} ${i.message}`).join('; ')}`)
  }
  const c = check.value
  return {
    file: true,
    port: c.port ?? DEFAULT_WEBHOOK_PORT,
    environment: c.environment ?? null,
    allowHosts: c.allowHosts ?? [],
    maxEvents: c.maxEvents ?? DEFAULT_MAX_EVENTS,
    maxBodyBytes: (c.maxBodyKB ?? DEFAULT_MAX_BODY_KB) * 1024,
    hooks: c.hooks ?? []
  }
}

/** Nome da variável de uma referência {{VAR}} (o schema garante a forma). */
export function variableName(ref: string): string {
  return ref.replace(/^\{\{\s*|\s*\}\}$/g, '')
}

/** O hook como a interface e o MCP mostram: a variável da chave da assinatura fica de fora. */
export function hookInfo(hook: WebhookHook): WebhookHookInfo {
  const t = hook.trigger
  return {
    id: hook.id,
    ...(hook.name && { name: hook.name }),
    path: hook.path,
    ...(hook.methods && { methods: [...hook.methods] }),
    ...(hook.signature && { signatureHeader: hook.signature.header }),
    status: hook.response?.status ?? 200,
    ...(t && {
      trigger: {
        kind: t.flow !== undefined ? ('flow' as const) : ('scenarios' as const),
        target: t.flow ?? t.connector ?? '',
        ...(t.environment !== undefined && { environment: t.environment })
      }
    })
  }
}
