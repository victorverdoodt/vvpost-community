import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SecretsEngineMode } from '@vvpost/schemas'

/*
 * Leitura leve de .vvpost/secrets-engine.json para a barra de status: só JSON.parse,
 * sem schemas nem Fastify, porque roda no polling do shell. A validação de verdade
 * fica com resolveEngineConfig, quando o engine liga.
 */

export interface EngineModes {
  /** Modo do arquivo do workspace (padrão localMock). */
  configured: SecretsEngineMode
  /** O workspace tem o bloco enterpriseProxy, então o Cloud Proxy pode ligar. */
  proxy: boolean
}

export async function readEngineModes(dir: string): Promise<EngineModes> {
  try {
    const doc = JSON.parse(await readFile(join(dir, '.vvpost/secrets-engine.json'), 'utf8')) as { mode?: unknown; enterpriseProxy?: unknown }
    const proxy = typeof doc.enterpriseProxy === 'object' && doc.enterpriseProxy !== null
    return { configured: doc.mode === 'enterpriseProxy' && proxy ? 'enterpriseProxy' : 'localMock', proxy }
  } catch {
    return { configured: 'localMock', proxy: false }
  }
}
