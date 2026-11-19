import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EnterpriseProxyConfig, SecretsEngineMode, SecretsProvider } from '@vvpost/schemas'
import type { ControlPlaneExtension } from '../enterprise/control-plane'
import type { EnterpriseIdentity } from '@shared/ipc'

/**
 * Pontos de extensão do Secret Engine para o módulo Enterprise.
 *
 * O core (Apache 2.0) só define o contrato: os emuladores de Azure Key Vault, AWS
 * Secrets Manager e HashiCorp Vault falam com um SecretBackend, e toda operação
 * passa por uma trilha de auditoria. O backend do modo localMock é o cofre
 * local cifrado (vault.ts); o do modo enterpriseProxy (SSO corporativo, cofre
 * real na nuvem, só em RAM) vem de um pacote externo, sob licença comercial, que
 * implementa EnterpriseSecretsModule. Nenhuma lógica proprietária mora aqui.
 */

/** Um segredo como os emuladores o enxergam. */
export interface SecretRecord {
  name: string
  value: string
  /** Identificador da versão: muda a cada escrita, igual para o mesmo conteúdo. */
  version: string
  /** Epoch em ms da última mudança. */
  updatedAt: number
}

/** De onde os emuladores leem e para onde escrevem. */
export interface SecretBackend {
  /** O que está sendo servido (ambiente local ou cofre remoto); null quando não há nada ativo. */
  readonly environment: string | null
  list(): Promise<SecretRecord[]>
  get(name: string): Promise<SecretRecord | undefined>
  /** Cria ou troca o valor. Devolve o registro gravado. */
  set(name: string, value: string): Promise<SecretRecord>
  /** Apaga; devolve false se o segredo não existia. */
  delete(name: string): Promise<boolean>
  /** Chamado quando o engine desliga: sessões e caches em memória são descartados aqui. */
  close?(): Promise<void>
}

/**
 * Uma linha da trilha de auditoria. Nunca carrega o valor do segredo, só o nome.
 * `api` é o protocolo emulado pelo qual o cliente local pediu.
 */
export interface SecretAuditEvent {
  /** ISO 8601. */
  at: string
  mode: SecretsEngineMode
  api: SecretsProvider
  action: 'list' | 'get' | 'set' | 'delete'
  /** Ausente em list. */
  secret?: string
  environment: string | null
  outcome: 'ok' | 'notFound' | 'error'
  /** Mensagem do erro, quando outcome é error. */
  error?: string
}

/**
 * Recebe cada evento antes da resposta sair para o cliente. Se lançar, a operação
 * falha (fail-closed): um segredo nunca é entregue sem a linha de auditoria.
 */
export type SecretAuditSink = (event: SecretAuditEvent) => void | Promise<void>

/** O que o core entrega ao módulo Enterprise ao ligar o engine. */
export interface EnterpriseContext {
  /** Raiz do workspace aberto. */
  workspaceDir: string
  /** Bloco enterpriseProxy de .vvpost/secrets-engine.json, já validado pelo schema. */
  config: EnterpriseProxyConfig
  /** Abre uma URL no navegador do sistema (login SSO interativo). Ausente fora do app. */
  openExternal?: (url: string) => Promise<void>
}

/**
 * Contrato do pacote Enterprise. O módulo é carregado de VVPOST_ENTERPRISE_MODULE
 * (caminho absoluto ou nome de pacote), do módulo empacotado no instalador
 * (setBundledEnterpriseModule) ou, sem nenhum dos dois, do pacote ENTERPRISE_PACKAGE se
 * estiver instalado; também pode ser registrado direto com registerEnterpriseModule.
 * O export default (ou o próprio namespace) precisa ter esta forma.
 */
export interface EnterpriseSecretsModule {
  /** Versão do contrato que o módulo implementa; precisa ser ENTERPRISE_API_VERSION. */
  apiVersion: number
  /** Autentica (SSO) e devolve o backend que busca no cofre real. */
  createBackend(context: EnterpriseContext): Promise<SecretBackend>
  /** Trilha de auditoria. Sem ela o modo enterpriseProxy não liga. */
  audit: SecretAuditSink
  /** Control Plane opcional da organização: recebe a atividade do desktop. */
  controlPlane?: ControlPlaneExtension
  /** Conta corporativa (OIDC com PKCE) e permissões vindas do Control Plane; ver enterprise/identity.ts. */
  identity?: EnterpriseIdentityExtension
  /** A organização pelo endereço do Control Plane, sem enterprise.json; ver enterprise/organization.ts. */
  organization?: EnterpriseOrganizationExtension
}

/** O endereço do Control Plane antes do login (.vvpost/organization.json ou `vvpost login`). */
export interface OrganizationRef {
  /** Origem HTTPS do Control Plane, ex.: https://vvpost.contoso.com */
  controlPlane: string
  /** Projeto do Control Plane cuja política vale. */
  project?: string
  /** Ambiente cujos segredos o broker entrega. */
  environment?: string
}

/**
 * Configuração da organização vinda do Control Plane: com só o endereço, o módulo busca a
 * descoberta pública (IdP, cliente OIDC, escopo) e, depois do login, a política e o catálogo.
 */
export interface EnterpriseOrganizationExtension {
  /** A organização que o workspace declara; vale acima da registrada e do enterprise.json. null volta a eles. */
  use(ref: OrganizationRef | null): void
  /** `vvpost login`: confirma o host e registra a organização na máquina; com openExternal, testa o login. */
  register(ref: OrganizationRef, openExternal?: (url: string) => Promise<void>): Promise<{ name: string; controlPlane: string; project?: string; user?: string }>
}

/**
 * Conta corporativa do módulo. Tokens e sessão ficam dentro dele, no processo principal; o core
 * só repassa o estado (sem token nenhum) e os pedidos de login, logout e troca de organização.
 */
export interface EnterpriseIdentityExtension {
  /** null quando o módulo não tem conta corporativa configurada. */
  state(): EnterpriseIdentity | null
  /** Abre o login no navegador do sistema (Authorization Code com PKCE). */
  signIn(openExternal: (url: string) => Promise<void>): Promise<void>
  signOut(): Promise<void>
  switchOrganization(id: string): Promise<void>
  onChange(listener: () => void): () => void
}

export const ENTERPRISE_API_VERSION = 1
export const ENTERPRISE_PACKAGE = '@vvpost/enterprise'

let registered: EnterpriseSecretsModule | null = null
let bundled: string | null = null

/**
 * Caminho absoluto do módulo que veio no instalador do app (resources/enterprise, só nos
 * builds com o módulo). VVPOST_ENTERPRISE_MODULE continua tendo prioridade. null limpa.
 */
export function setBundledEnterpriseModule(path: string | null): void {
  bundled = path
}

/** Registra o módulo Enterprise sem passar pelo carregamento dinâmico (embutido ou em testes). null limpa. */
export function registerEnterpriseModule(mod: EnterpriseSecretsModule | null): void {
  registered = mod === null ? null : checkModule(mod, 'registerEnterpriseModule')
}

export class EnterpriseModuleMissingError extends Error {
  constructor() {
    super(
      `O modo enterpriseProxy precisa do módulo VVPost Enterprise, que não está instalado. ` +
        `Instale ${ENTERPRISE_PACKAGE} (ou aponte VVPOST_ENTERPRISE_MODULE para ele) ou use mode "localMock".`
    )
  }
}

/** O módulo registrado, ou o carregado de VVPOST_ENTERPRISE_MODULE, do instalador ou de ENTERPRISE_PACKAGE. */
export async function loadEnterpriseModule(env: NodeJS.ProcessEnv = process.env): Promise<EnterpriseSecretsModule> {
  if (registered) return registered
  const explicit = env['VVPOST_ENTERPRISE_MODULE']?.trim() || bundled
  const specifier = explicit || ENTERPRISE_PACKAGE
  let ns: Record<string, unknown>
  try {
    const target = isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier
    ns = (await import(/* @vite-ignore */ target)) as Record<string, unknown>
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Só o próprio pacote ausente: uma dependência faltando dentro dele é outro erro.
    const missing = (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && (err as Error).message.includes(ENTERPRISE_PACKAGE)
    if (!explicit && missing) throw new EnterpriseModuleMissingError()
    throw new Error(`Falha ao carregar o módulo Enterprise (${specifier}): ${(err as Error).message}`)
  }
  return checkModule((ns['default'] ?? ns) as EnterpriseSecretsModule, specifier)
}

function checkModule(mod: EnterpriseSecretsModule, from: string): EnterpriseSecretsModule {
  if (typeof mod?.createBackend !== 'function' || typeof mod.audit !== 'function') {
    throw new Error(`${from} não é um módulo Enterprise válido: faltam createBackend() e audit().`)
  }
  if (mod.controlPlane !== undefined && typeof mod.controlPlane?.activity !== 'function') {
    throw new Error(`${from} não é um módulo Enterprise válido: controlPlane sem activity().`)
  }
  const id = mod.identity
  if (id !== undefined && (['state', 'signIn', 'signOut', 'switchOrganization', 'onChange'] as const).some((k) => typeof id?.[k] !== 'function')) {
    throw new Error(`${from} não é um módulo Enterprise válido: identity precisa de state(), signIn(), signOut(), switchOrganization() e onChange().`)
  }
  if (mod.apiVersion !== ENTERPRISE_API_VERSION) {
    throw new Error(
      `${from} implementa a versão ${String(mod.apiVersion)} do contrato Enterprise; este VVPost espera a ${ENTERPRISE_API_VERSION}.`
    )
  }
  return mod
}

/**
 * Envolve o backend para que cada operação feita por um emulador gere um evento na
 * trilha. O evento é gravado antes do resultado voltar ao emulador.
 */
export function withAudit(backend: SecretBackend, sink: SecretAuditSink, mode: SecretsEngineMode, api: SecretsProvider): SecretBackend {
  const emit = (action: SecretAuditEvent['action'], secret: string | undefined, outcome: SecretAuditEvent['outcome'], error?: string) =>
    sink({
      at: new Date().toISOString(),
      mode,
      api,
      action,
      ...(secret === undefined ? {} : { secret }),
      environment: backend.environment,
      outcome,
      ...(error === undefined ? {} : { error })
    })

  async function run<T>(action: SecretAuditEvent['action'], secret: string | undefined, op: () => Promise<T>, found: (r: T) => boolean): Promise<T> {
    let result: T
    try {
      result = await op()
    } catch (err) {
      await emit(action, secret, 'error', (err as Error).message)
      throw err
    }
    await emit(action, secret, found(result) ? 'ok' : 'notFound')
    return result
  }

  return {
    get environment() {
      return backend.environment
    },
    list: () => run('list', undefined, () => backend.list(), () => true),
    get: (name) => run('get', name, () => backend.get(name), (r) => r !== undefined),
    set: (name, value) => run('set', name, () => backend.set(name, value), () => true),
    delete: (name) => run('delete', name, () => backend.delete(name), (r) => r)
  }
}
