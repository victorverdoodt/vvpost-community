import type { BodyCheck, HttpHeader, HttpMethod, SchemaField } from '../types'

/**
 * O que documentar, pelo nível da hierarquia em que o usuário pediu: o projeto inteiro,
 * um conector (com os endpoints), um endpoint ou uma request (cenário de um endpoint).
 */
export type DocScope =
  | { kind: 'project' }
  | { kind: 'connector'; connectorId: string }
  | { kind: 'endpoint'; connectorId: string; endpointId: string }
  | { kind: 'request'; connectorId: string; endpointId: string; scenarioId: string }

/** Valor herdado com o conector que o define e os ancestrais que ele substitui. */
export type DocHeader = HttpHeader & { from: string; overrides: string[] }

export interface DocVariable {
  name: string
  /** isSecret ou nome de credencial: o valor nunca entra na documentação. */
  secret: boolean
  /** Valor por ambiente (id → valor), só de variáveis que não são segredo. */
  values: Record<string, string>
  /** Ambientes que não declaram a variável. */
  missingIn: string[]
  description?: string
}

export interface DocEnvironment {
  id: string
  name: string
  file?: string
  variables: number
  secrets: number
}

export interface DocAssertion {
  target: string
  operator: string
  /** Valor esperado em texto (JSON para objetos), ausente em exists/notExists. */
  expected?: string
}

export interface DocScenario {
  id: string
  name: string
  description?: string
  /** O que o cenário muda na request do endpoint, como escrito no arquivo. */
  overrides: {
    body?: string
    /** null: remove todos os headers herdados. */
    headers?: { name: string; value: string | null }[] | null
    query?: { name: string; value: string | null }[]
    pathParams?: { name: string; value: string }[]
  }
  assertions: DocAssertion[]
  /** Status HTTP esperado (asserção status equals), para os diagramas. */
  expectedStatus?: number
  /** Corpo do cenário conferido com o bodySchema. */
  check?: BodyCheck
}

export interface DocFlowUsage {
  id: string
  name: string
  file: string
  description?: string
  /** Nós do fluxo que chamam o endpoint. */
  nodes: string[]
  /** O fluxo em Mermaid, com os nós do endpoint em destaque. */
  diagram: string
}

export interface DocEndpoint {
  id: string
  name: string
  method: HttpMethod
  path: string
  /** URL montada com a herança (baseUrl + basePath + path), com {{VAR}}. */
  url?: string
  /** true: exige credencial; false: público. */
  requiresAuth?: boolean
  description?: string
  /** Seção {#id} do *.connector.vvpost.md. */
  docs?: string
  pathParams: string[]
  /** Headers efetivos: os da cadeia de conectores e os do próprio endpoint (from = id do endpoint). */
  headers: DocHeader[]
  query: HttpHeader[]
  /** Variáveis {{VAR}} usadas pelo endpoint, pela herança e pelos cenários. */
  variables: string[]
  bodySchema?: string
  /** O corpo é um schema compartilhado do catálogo, o mesmo em todo endpoint que o cita. */
  sharedSchema?: { name: string; file: string }
  fields: SchemaField[]
  body?: string
  checks: BodyCheck[]
  scenarios: DocScenario[]
  flows: DocFlowUsage[]
  diagrams: { sequence: string }
}

export interface DocConnector {
  id: string
  name: string
  version: string
  description?: string
  file: string
  /** Arquivo de documentação escrita (*.connector.vvpost.md), quando existe. */
  docsFile?: string
  /** Visão geral do *.connector.vvpost.md (sem as seções de endpoint). */
  overview?: string
  extends?: string
  /** Raiz até o conector: id e nome. */
  chain: { id: string; name: string }[]
  children: string[]
  /** Somente leitura: vem do catálogo compartilhado da organização. */
  shared?: string
  effective?: {
    baseUrl?: { value: string; from: string }
    basePath: string
    headers: DocHeader[]
    /** Auth efetiva; em details, campos de credencial só aparecem como {{VAR}}. */
    auth?: { type: string; summary: string; from: string; details: { name: string; value: string }[] }
    authDisabledBy?: string
    tlsFrom?: string
  }
  error?: string
  diagrams: { hierarchy: string; auth?: string }
  endpoints: DocEndpoint[]
  /** Endpoints do conector que ficaram de fora do escopo (documentação de um endpoint só). */
  omittedEndpoints: number
}

export interface DocFlowSummary {
  id: string
  name: string
  file: string
  description?: string
  nodes: number
  /** Conectores que o fluxo chama. */
  connectors: string[]
}

export interface ApiDocument {
  /** Título do documento, pelo escopo. */
  title: string
  scope: DocScope
  /** Rótulo do escopo: "Projeto", "Conector", "Endpoint" ou "Request". */
  scopeLabel: string
  generatedAt: string
  generator: string
  project: {
    name: string
    connectors: number
    endpoints: number
    scenarios: number
    flows: number
    environments: DocEnvironment[]
    /** Mapa do projeto (conectores, herança, endpoints e fluxos), só no escopo do projeto. */
    map?: string
    /** C4 de contexto gerado do catálogo ({{> c4}}), só no escopo do projeto. */
    c4?: string
    flowList: DocFlowSummary[]
  }
  connectors: DocConnector[]
  /** Variáveis usadas pelo que está no documento, com o valor por ambiente quando não é segredo. */
  variables: DocVariable[]
  /** Arquivos ignorados e problemas de herança que afetam o documento. */
  issues: { file: string; message: string }[]
}
