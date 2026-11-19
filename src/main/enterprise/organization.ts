import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrganizationRef } from '../secret-engine/backend'

/**
 * A organização que o workspace declara: `.vvpost/organization.json`, versionado com o
 * workspace, com o endereço do Control Plane (e, se quiser, o projeto e o ambiente do broker).
 * Com ele, o MCP desse workspace só sai do modo mais restrito com a política da organização em
 * vigor, mesmo sem o módulo Enterprise. A configuração em si (o IdP, a política, o catálogo) vem
 * do Control Plane, não do arquivo.
 */
export const ORGANIZATION_FILE = join('.vvpost', 'organization.json')

const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Confere a referência; mensagem com o arquivo e o campo. */
export function parseOrganization(raw: unknown, where: string): OrganizationRef {
  const fail = (msg: string): never => {
    throw new Error(`${where}: ${msg}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('precisa ser um objeto { "controlPlane": "https://..." }')
  const r = raw as Record<string, unknown>
  let url: URL | null = null
  try {
    url = typeof r['controlPlane'] === 'string' ? new URL(r['controlPlane']) : null
  } catch {
    url = null
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password) fail('controlPlane precisa ser a URL HTTPS do Control Plane, sem usuário ou senha')
  const key = (name: 'project' | 'environment') => {
    const v = r[name]
    if (v === undefined) return undefined
    return typeof v === 'string' && KEY.test(v) ? v : fail(`${name} não é uma chave válida (minúsculas, números, ".", "_" e "-")`)
  }
  const project = key('project')
  const environment = key('environment')
  return { controlPlane: url!.origin, ...(project && { project }), ...(environment && { environment }) }
}

/**
 * A organização declarada pelo projeto ou, sem ele, pela raiz do workspace. null quando nenhum
 * declara; arquivo inválido lança (melhor parar do que seguir sem a política que ele pede).
 */
export async function readOrganization(dirs: string[]): Promise<OrganizationRef | null> {
  for (const dir of dirs) {
    const file = join(dir, ORGANIZATION_FILE)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new Error(`${file}: JSON inválido (${(err as Error).message})`)
    }
    return parseOrganization(parsed, file)
  }
  return null
}
