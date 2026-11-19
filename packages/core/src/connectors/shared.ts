/*
 * Sem imports de propósito: o app registra o provider na partida sem carregar o
 * resto do pacote (schemas, validação) fora do caminho do cold start.
 */

/**
 * Conector publicado fora do workspace, como o catálogo corporativo do Control
 * Plane: o mesmo documento *.connector.vvpost.json, ou um fluxo-base e os fluxos de
 * requisição dele (*.flow.vvpost.json), somente leitura. O core não sabe de onde veio;
 * `source` só aparece nas mensagens e no Catálogo.
 */
export interface SharedConnector {
  /** Origem legível, ex.: cp.contoso.com/payments@org:3. */
  source: string
  doc: unknown
}

export type SharedConnectorsProvider = (dir: string) => Promise<SharedConnector[]>

let provider: SharedConnectorsProvider | null = null

/**
 * Registra quem entrega os conectores compartilhados de todo loadWorkspace sem
 * `shared` explícito (no app, o módulo Enterprise; null desliga). Sem registro, o
 * workspace é só o que está no disco.
 */
export function setSharedConnectors(next: SharedConnectorsProvider | null): void {
  provider = next
}

export function sharedConnectorsProvider(): SharedConnectorsProvider | null {
  return provider
}
