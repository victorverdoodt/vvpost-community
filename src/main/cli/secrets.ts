import { readFile } from 'node:fs/promises'
import type { LoadedWorkspace } from '@vvpost/core/connectors/workspace'

/** Prefixo das variáveis de ambiente do processo que levam segredos do CI ao workspace. */
export const SECRET_ENV_PREFIX = 'VVPOST_SECRET_'

export interface CiValues {
  /** Conteúdo de --secrets: id do ambiente → variável → valor, no mesmo formato do cofre local. */
  file?: Record<string, Record<string, string>>
  /** VVPOST_SECRET_<VAR>=valor: vale para todo ambiente que declara VAR. */
  env: Record<string, string>
  /** --var NOME=valor: troca o valor de NOME em todo ambiente que o declara. */
  vars: Record<string, string>
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Lê o arquivo de --secrets; formato errado é erro de uso. */
export async function readSecretsFile(path: string): Promise<Record<string, Record<string, string>>> {
  let doc: unknown
  try {
    doc = JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    throw new Error(`--secrets ${path}: ${err instanceof SyntaxError ? `JSON inválido (${err.message})` : (err as Error).message}`)
  }
  if (!isRecord(doc)) throw new Error(`--secrets ${path}: deve ser um objeto { "<id do ambiente>": { "VAR": "valor" } }`)
  const out: Record<string, Record<string, string>> = {}
  for (const [envId, vars] of Object.entries(doc)) {
    if (!isRecord(vars)) throw new Error(`--secrets ${path}: "${envId}" deve ser um objeto { "VAR": "valor" }`)
    out[envId] = {}
    for (const [name, value] of Object.entries(vars)) {
      if (typeof value !== 'string') throw new Error(`--secrets ${path}: ${envId}.${name} deve ser texto`)
      out[envId][name] = value
    }
  }
  return out
}

export function secretsFromProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(SECRET_ENV_PREFIX) && key.length > SECRET_ENV_PREFIX.length && value !== undefined) {
      out[key.slice(SECRET_ENV_PREFIX.length)] = value
    }
  }
  return out
}

/**
 * Aplica no workspace lido os valores que o CI injeta, só em memória: nada é gravado.
 * Segredos entram em `ws.secrets` (o mesmo mapa do cofre local, que
 * environmentValues já lê), com prioridade VVPOST_SECRET_* < --secrets < --var.
 * Um --var de variável secreta também vira segredo, para nunca ir ao ambiente em texto.
 */
export function applyCiValues(ws: LoadedWorkspace, values: CiValues): void {
  for (const [envId, env] of ws.environments) {
    const secrets = (ws.secrets[envId] ??= {})
    for (const [name, value] of Object.entries(values.env)) if (name in env.variables) secrets[name] = value
    for (const [name, value] of Object.entries(values.file?.[envId] ?? {})) secrets[name] = value
    for (const [name, value] of Object.entries(values.vars)) {
      const variable = env.variables[name]
      if (!variable) continue
      if (variable.isSecret) secrets[name] = value
      else env.variables[name] = { ...variable, value }
    }
  }
}
