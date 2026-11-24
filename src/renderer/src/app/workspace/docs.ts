/**
 * Documentos que abrem numa aba própria do workspace: o editor da aba muda pelo tipo do arquivo
 * (conector, endpoint, cenário, documento .md, diagrama .mmd, tokens da marca). Fluxos e requisições abrem nas abas
 * do Flow Studio e do Quick Request (lib/shell-tabs); ambientes, no módulo Secrets.
 */
export type DocRef =
  /** connectorId null: conector novo. */
  | { kind: 'connector'; connectorId: string | null }
  | { kind: 'endpoint'; connectorId: string; endpointId: string }
  /** Sem scenarioId: cenário novo (no endpoint, ou o editor pede o endpoint). */
  | { kind: 'scenario'; connectorId: string; endpointId?: string; scenarioId?: string }
  /** section: abre no título da seção (o Ctrl+clique num {{> include arquivo#seção}}). */
  | { kind: 'markdown'; file: string; section?: string }
  /** file null: diagrama novo, ainda sem arquivo. */
  | { kind: 'diagram'; file: string | null }
  /** Arquivo de tokens da marca (brand/*.tokens.json), relativo ao projeto. */
  | { kind: 'brand'; file: string }

export type DocKind = DocRef['kind']

let fresh = 0

/** Chave estável da aba: o mesmo arquivo abre sempre na mesma aba; um documento novo, numa aba nova. */
export function docKey(ref: DocRef): string {
  switch (ref.kind) {
    case 'connector':
      return `doc:connector:${ref.connectorId ?? `new-${++fresh}`}`
    case 'endpoint':
      return `doc:endpoint:${ref.connectorId}/${ref.endpointId}`
    case 'scenario':
      return ref.scenarioId
        ? `doc:scenario:${ref.connectorId}/${ref.endpointId ?? ''}/${ref.scenarioId}`
        : `doc:scenario:${ref.connectorId}/${ref.endpointId ?? ''}/new-${++fresh}`
    case 'markdown':
      return `doc:markdown:${ref.file}`
    case 'diagram':
      return `doc:diagram:${ref.file ?? `new-${++fresh}`}`
    case 'brand':
      return `doc:brand:${ref.file}`
  }
}

const base = (file: string) => file.slice(file.lastIndexOf('/') + 1)

/** Título da aba, com os nomes do catálogo quando já foi lido. */
export function docTitle(
  ref: DocRef,
  names: { connector(id: string): string | undefined; endpoint(c: string, e: string): string | undefined; scenario(c: string, e: string, s: string): string | undefined }
): string {
  switch (ref.kind) {
    case 'connector':
      return ref.connectorId ? (names.connector(ref.connectorId) ?? ref.connectorId) : 'Novo conector'
    case 'endpoint':
      return names.endpoint(ref.connectorId, ref.endpointId) ?? ref.endpointId
    case 'scenario':
      return ref.scenarioId && ref.endpointId
        ? (names.scenario(ref.connectorId, ref.endpointId, ref.scenarioId) ?? ref.scenarioId)
        : 'Novo cenário'
    case 'markdown':
      return base(ref.file)
    case 'diagram':
      return ref.file ? base(ref.file) : 'Novo diagrama'
    case 'brand':
      return base(ref.file)
  }
}

/** Pedido para abrir um documento numa aba (explorador, modal Novo, menus). O App escuta. */
export const OPEN_DOC = 'vvpost:open-doc'

export function openDoc(ref: DocRef): void {
  // A seção pedida fica guardada até a aba do arquivo (já aberta ou que vai abrir) mostrar o título.
  if (ref.kind === 'markdown' && ref.section) sections.set(ref.file, ref.section)
  window.dispatchEvent(new CustomEvent<DocRef>(OPEN_DOC, { detail: ref }))
  if (ref.kind === 'markdown' && ref.section) window.dispatchEvent(new CustomEvent<string>(REVEAL_SECTION, { detail: ref.file }))
}

/** Pedido para fechar a aba de um arquivo que foi renomeado ou excluído (explorador). O App escuta. */
export const CLOSE_DOC = 'vvpost:close-doc'

export function closeDocTab(ref: DocRef): void {
  window.dispatchEvent(new CustomEvent<string>(CLOSE_DOC, { detail: docKey(ref) }))
}

/** Pedido de mostrar uma seção de um .md: a aba do arquivo pega com takeSection. */
export const REVEAL_SECTION = 'vvpost:reveal-section'
const sections = new Map<string, string>()

export function takeSection(file: string): string | undefined {
  const section = sections.get(file)
  sections.delete(file)
  return section
}

/** Um .md ou .mmd foi criado ou gravado: o explorador relê a lista de arquivos. */
export const FILES_CHANGED = 'vvpost:files-changed'

export const filesChanged = (): void => void window.dispatchEvent(new Event(FILES_CHANGED))

/** O que o editor de uma aba pode pedir ao shell. */
export interface DocTab {
  /** A aba está à mostra. */
  active: boolean
  close(): void
  /** O documento novo foi salvo e virou um arquivo: a aba passa a ser a dele. */
  replace(ref: DocRef): void
  setDirty(dirty: boolean): void
}
