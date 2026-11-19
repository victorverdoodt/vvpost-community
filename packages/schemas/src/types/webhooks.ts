/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

export type WebhookHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/**
 * Servidor local de webhooks, em .vvpost/webhooks.json. Sem o arquivo, o servidor aceita qualquer caminho e responde 200; os hooks dão a cada caminho uma resposta, uma assinatura conferida e um disparo de fluxo ou de cenários.
 */
export interface WebhooksConfig {
  /**
   * URL do schema, usada por editores para autocomplete.
   */
  $schema?: string
  /**
   * Porta local em que o servidor escuta (só em 127.0.0.1).
   */
  port?: number
  /**
   * Ambiente que resolve as variáveis das assinaturas e em que os disparos rodam quando o hook não diz outro. Padrão: o primeiro de environments/.
   */
  environment?: string
  /**
   * Hosts aceitos no header Host além de localhost e 127.0.0.1, ex.: o domínio de um túnel (ngrok, cloudflared) que repassa para a porta local.
   */
  allowHosts?: string[]
  /**
   * Eventos guardados em memória; passou disso, os mais antigos saem. Nada vai para o disco.
   */
  maxEvents?: number
  /**
   * Maior corpo aceito, em KB; um corpo maior recebe 413 e o evento fica registrado sem ele.
   */
  maxBodyKB?: number
  hooks?: WebhookHook[]
}
/**
 * Um endpoint do servidor. O hook mais específico vale: caminho exato antes de /*, e o /* mais longo antes do mais curto.
 */
export interface WebhookHook {
  /**
   * Identificador estável, ex.: pagamentos.
   */
  id: string
  name?: string
  description?: string
  /**
   * Caminho atendido, ex.: /pagamentos. Terminado em /* aceita também os subcaminhos.
   */
  path: string
  /**
   * Métodos aceitos; os outros recebem 405. Padrão: todos.
   *
   * @minItems 1
   */
  methods?: [WebhookHttpMethod, ...WebhookHttpMethod[]]
  response?: WebhookResponse
  signature?: WebhookSignature
  trigger?: WebhookTrigger
}
/**
 * O que o servidor responde a quem mandou o evento. Padrão: 200 com {"received": true}.
 */
export interface WebhookResponse {
  status?: number
  headers?: {
    [k: string]: string
  }
  /**
   * Texto, ou JSON (enviado com application/json).
   */
  body?: unknown
  /**
   * Espera antes de responder, para simular um receptor lento (e testar o timeout de quem envia).
   */
  delayMs?: number
}
/**
 * Assinatura HMAC do corpo, como as do GitHub (X-Hub-Signature-256, prefixo sha256=) e da maioria dos provedores. Um evento sem a assinatura certa recebe 401, fica registrado como recusado e não dispara nada.
 */
export interface WebhookSignature {
  /**
   * Header com a assinatura.
   */
  header: string
  /**
   * Variável do ambiente com a chave, como {{WEBHOOK_SECRET}}: o valor fica no vault local, nunca neste arquivo.
   */
  secret: string
  algorithm?: 'sha256' | 'sha1' | 'sha512'
  encoding?: 'hex' | 'base64'
  /**
   * Texto antes do valor no header, ex.: sha256=.
   */
  prefix?: string
}
/**
 * Roda um fluxo ou os cenários de um conector a cada evento aceito, com os limites de quem dispara sem humano. No fluxo, um nó webhook recebe o evento que disparou.
 */
export interface WebhookTrigger {
  /**
   * Id de um fluxo do workspace.
   */
  flow?: string
  /**
   * Id do conector cujos cenários rodam.
   */
  connector?: string
  /**
   * Só com connector: "<endpoint>" ou "<endpoint>/<cenário>". Padrão: todos os cenários do conector.
   *
   * @minItems 1
   */
  scenarios?: [string, ...string[]]
  /**
   * Ambiente da execução. Padrão: o environment do arquivo; "" roda sem ambiente.
   */
  environment?: string
}
