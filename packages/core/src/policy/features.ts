/**
 * Recursos que a organização pode desligar por inteiro (docs/control-plane.md, "Recursos
 * desligados"): cada um abre uma superfície própria (código de terceiros, um processo Python,
 * um servidor local escutando numa porta, um protocolo além do HTTP), e uma equipe de segurança
 * pode preferir que ela nem exista nas máquinas da empresa. `piiVisible` é o contrário de uma
 * superfície: desligado, quem usa o app e o CLI vê os dados pessoais mascarados.
 * A lista é fechada: o Control Plane recusa id desconhecido, e o core ignora um id que não conhece.
 *
 * Quem diz o que está desligado é a política central (módulo Enterprise, setFeaturePolicy) e,
 * em qualquer build, a variável VVPOST_DISABLE_FEATURES. As duas só desligam: nada aqui liga
 * um recurso que a outra desligou.
 */
export const FEATURES = {
  secretEmulator: 'Emulador local de cofres (Secret Engine no modo mock)',
  pythonNode: 'Nó Python do Flow Studio',
  scripts: 'Scripts por requisição (pre e post)',
  plugins: 'Plugins instalados pelo usuário',
  protocols: 'Protocolos além do HTTP (WebSocket, SSE, Socket.IO, GraphQL, gRPC e Kafka)',
  mockServer: 'Servidor mock',
  webhooks: 'Servidor local de webhooks',
  mcp: 'Servidor MCP para agentes de IA',
  /** Desligado: o app e o CLI mostram os dados pessoais mascarados, como o agente vê (pii-people.ts). */
  piiVisible: 'Dados pessoais (campos x-sensitive) à vista no app e no CLI'
} as const

export type FeatureId = keyof typeof FEATURES

export const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[]

export const DISABLE_FEATURES_ENV = 'VVPOST_DISABLE_FEATURES'

export function isFeatureId(id: string): id is FeatureId {
  return Object.prototype.hasOwnProperty.call(FEATURES, id)
}

/** O que a política central diz agora; `source` entra nas mensagens ("política da organização (cp.contoso.com/org)"). */
export interface FeaturePolicy {
  disabled: readonly string[]
  source: string
}

export interface DisabledFeature {
  id: FeatureId
  label: string
  /** Quem desligou, para a mensagem. */
  source: string
}

let central: (() => FeaturePolicy | null) | null = null

/** O módulo Enterprise (pelo core) diz o que a organização desligou; null volta a só valer a variável. */
export function setFeaturePolicy(read: (() => FeaturePolicy | null) | null): void {
  central = read
}

function fromEnv(): string[] {
  const raw = globalThis.process?.env?.[DISABLE_FEATURES_ENV]
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []
}

/** Os recursos desligados agora, na ordem de FEATURES. A política central vence a variável na mensagem. */
export function disabledFeatures(): DisabledFeature[] {
  const by = new Map<string, string>()
  for (const id of fromEnv()) by.set(id, DISABLE_FEATURES_ENV)
  const policy = central?.()
  for (const id of policy?.disabled ?? []) by.set(id, policy!.source)
  return FEATURE_IDS.filter((id) => by.has(id)).map((id) => ({ id, label: FEATURES[id], source: by.get(id)! }))
}

/** Por que o recurso está desligado, ou null se pode ser usado. */
export function featureDenial(id: FeatureId): string | null {
  const off = disabledFeatures().find((f) => f.id === id)
  return off ? `${off.label}: desligado pela ${off.source === DISABLE_FEATURES_ENV ? `variável ${DISABLE_FEATURES_ENV}` : off.source}` : null
}

export class FeatureDisabledError extends Error {
  readonly code = 'POLICY_DENIED'
  constructor(
    readonly feature: FeatureId,
    message: string
  ) {
    super(message)
    this.name = 'FeatureDisabledError'
  }
}

/** Lança FeatureDisabledError (código POLICY_DENIED) se o recurso está desligado. */
export function assertFeature(id: FeatureId): void {
  const denial = featureDenial(id)
  if (denial) throw new FeatureDisabledError(id, denial)
}

/** Tipos de nó que rodam código JavaScript do workspace (vvpost-plugin-javascript): seguem o recurso scripts. */
const SCRIPT_NODE_TYPES = new Set(['javascript.script', 'javascript.request-script'])

/**
 * Por que uma contribuição de plugin não pode rodar: adapter é protocolo, nó de script é script,
 * e tudo o que vem de um plugin instalado pelo usuário depende de plugins. null quando pode.
 */
export function pluginContributionDenial(kind: 'node' | 'adapter', name: string, source: 'official' | 'user' | undefined): string | null {
  return (
    (source === 'user' ? featureDenial('plugins') : null) ??
    (kind === 'adapter' ? featureDenial('protocols') : null) ??
    (kind === 'node' && SCRIPT_NODE_TYPES.has(name) ? featureDenial('scripts') : null)
  )
}
