import type { BodyFieldSpec } from '@vvpost/core/connectors/body-schema'
import type { Connector, ConnectorConfig, ConnectorSource, Endpoint, Environment, EnvironmentVariable, Flow, ResponseExample, Scenario } from '@vvpost/schemas'

/**
 * Uma alteração no projeto (o workspace VVPost). O app, o importador e a IA pelo
 * MCP descrevem o que querem mudar como uma lista destas operações, aplicada por
 * applyProjectOps em lote: uma operação vê o efeito das anteriores, e nada é
 * gravado se alguma falhar.
 */
export type ProjectOp =
  /** Cria ou substitui o documento inteiro. Sem `file`: connectors/<id>.connector.vvpost.json (ou o arquivo atual). */
  | { op: 'upsertConnector'; connector: Connector; file?: string }
  /** Muda campos do topo; null remove o campo. */
  | {
      op: 'patchConnector'
      id: string
      set: {
        name?: string
        description?: string | null
        version?: string
        extends?: string | null
        config?: ConnectorConfig | null
        source?: ConnectorSource | null
      }
    }
  /** Renomeia (atualiza o extends dos filhos e os nós dos fluxos), troca o pai ou muda de arquivo/pasta. */
  | { op: 'moveConnector'; id: string; newId?: string; extends?: string | null; file?: string }
  /** Recusado se outro conector herda dele. Apaga também o .connector.vvpost.md ao lado. */
  | { op: 'deleteConnector'; id: string }
  /**
   * Cria ou substitui um endpoint pelo id. Com `keepScenarios` (padrão) e sem
   * `endpoint.scenarios` (ou `endpoint.examples`), os cenários (e os exemplos de resposta)
   * que o endpoint já tinha continuam.
   */
  | { op: 'upsertEndpoint'; connectorId: string; endpoint: Endpoint; keepScenarios?: boolean; index?: number }
  /** Muda o endpoint de conector, de id ou de posição (índice na lista do conector de destino). */
  | { op: 'moveEndpoint'; connectorId: string; endpointId: string; toConnectorId?: string; newId?: string; index?: number }
  | { op: 'deleteEndpoint'; connectorId: string; endpointId: string }
  | { op: 'upsertScenario'; connectorId: string; endpointId: string; scenario: Scenario }
  | { op: 'deleteScenario'; connectorId: string; endpointId: string; scenarioId: string }
  /**
   * Troca o bodySchema inteiro (JSON Schema; null remove). Com `fromBody`, gera do corpo padrão do
   * endpoint (tipos e formatos pelos valores, nenhum obrigatório) no lugar de `schema`.
   */
  | { op: 'setBodySchema'; connectorId: string; endpointId: string; schema?: Record<string, unknown> | null; fromBody?: boolean }
  /**
   * Cria, troca (field) ou remove (null) um campo do bodySchema pelo caminho: `cliente.nome`,
   * `itens[].sku` (campo dos objetos da lista). Os objetos do caminho são criados quando faltam.
   */
  | { op: 'setBodyField'; connectorId: string; endpointId: string; path: string; field: BodyFieldSpec | null }
  /**
   * Schema compartilhado (schemas/<name>.schema.json), criado ou trocado: os endpoints citam com
   * {"$ref": "schema:<name>"} no bodySchema, no schema de um exemplo ou dentro de outro schema.
   */
  | { op: 'upsertSchema'; name: string; schema: Record<string, unknown> }
  /** Recusado enquanto algum endpoint, fluxo ou schema cita o schema. */
  | { op: 'deleteSchema'; name: string }
  /**
   * Como setBodyField, num schema compartilhado: vale para todos os endpoints que o citam. Com
   * `fillExamples`, o campo novo entra (com `field.example`, ou um valor vazio do tipo) nos exemplos
   * de resposta que citam o schema e ainda não o têm; com field null, sai deles.
   */
  | { op: 'setSchemaField'; name: string; path: string; field: BodyFieldSpec | null; fillExamples?: boolean }
  /**
   * A migração dos catálogos que repetem o mesmo schema em cada endpoint: toda entrada de $defs igual
   * em `minUses` (padrão 2) schemas ou mais vira um schema compartilhado, citado no lugar da cópia.
   */
  | { op: 'extractSchemas'; minUses?: number }
  /** Exemplo de resposta do endpoint (o que o mock server devolve), criado ou trocado pelo id. */
  | { op: 'upsertExample'; connectorId: string; endpointId: string; example: ResponseExample }
  | { op: 'deleteExample'; connectorId: string; endpointId: string; exampleId: string }
  /**
   * Cria o ambiente ou atualiza nome/descrição e mescla as variáveis. Sem
   * `overwriteValues`, uma variável que já existe mantém o valor.
   */
  | {
      op: 'upsertEnvironment'
      environment: { id: string; name: string; description?: string; variables?: Environment['variables'] }
      overwriteValues?: boolean
    }
  | { op: 'deleteEnvironment'; id: string }
  /**
   * Cria ou muda uma variável. `secret: true` grava __REQUIRED_SECRET__ no arquivo
   * versionado; o valor real vai para o vault só por storeSecret. Sem `overwrite`,
   * o valor de uma variável que já existe não muda (descrição e tipo mudam).
   */
  | {
      op: 'setVariable'
      environmentId: string
      name: string
      value?: string | number | boolean
      secret?: boolean
      description?: string
      placeholder?: string
      overwrite?: boolean
    }
  | { op: 'deleteVariable'; environmentId: string; name: string }
  /** Cria ou substitui um fluxo. Sem `file`: flows/<id>.flow.vvpost.json (ou o arquivo atual). */
  | { op: 'upsertFlow'; flow: Flow; file?: string }
  | { op: 'deleteFlow'; id: string }
  /**
   * Converte um conector do formato antigo em fluxos (docs/flows.md, Herança entre fluxos): um
   * fluxo-base em flows/<id>/<id>.flow.vvpost.json e um fluxo de requisição por endpoint ao lado,
   * com a documentação. Os ids continuam os mesmos, então quem herda ou usa o conector não muda.
   */
  | { op: 'migrateConnector'; id: string }
  /** Documentação Markdown do conector (<arquivo>.connector.vvpost.md); "" apaga o arquivo. */
  | { op: 'writeDoc'; connectorId: string; markdown: string }
  /** Valor real de um segredo, para o cofre local. Só o app e o importador; a IA nunca. */
  | { op: 'storeSecret'; environmentId: string; variable: string; value: string; overwrite?: boolean }

export type ProjectOpName = ProjectOp['op']

export const OP_NAMES: readonly ProjectOpName[] = [
  'upsertConnector',
  'patchConnector',
  'moveConnector',
  'deleteConnector',
  'upsertEndpoint',
  'moveEndpoint',
  'deleteEndpoint',
  'upsertScenario',
  'deleteScenario',
  'setBodySchema',
  'setBodyField',
  'upsertSchema',
  'deleteSchema',
  'setSchemaField',
  'extractSchemas',
  'upsertExample',
  'deleteExample',
  'upsertEnvironment',
  'deleteEnvironment',
  'setVariable',
  'deleteVariable',
  'upsertFlow',
  'deleteFlow',
  'migrateConnector',
  'writeDoc',
  'storeSecret'
]

export interface ProjectChange {
  /** Caminho relativo ao workspace, com "/". */
  path: string
  action: 'create' | 'update' | 'delete'
  before?: string
  after?: string
}

export interface ProjectOpIssue {
  /** Índice da operação no lote (-1: o lote todo). */
  op: number
  message: string
}

export interface ProjectApplyResult {
  ok: boolean
  dryRun: boolean
  changes: ProjectChange[]
  errors: ProjectOpIssue[]
  warnings: ProjectOpIssue[]
  /** storeSecret: gravados no vault e ignorados (já tinham valor e sem overwrite). */
  secrets: { stored: number; skipped: number }
  /** Conectores cuja auth, destino ou credenciais mudaram por uma escrita da IA: só disparam depois de revisados no app. */
  review: string[]
  /**
   * Arquivos que mudaram no disco por fora do lote (a pessoa gravou no app, outro agente): o
   * conteúdo esperado (`expect`, ou o que o lote leu) não é mais o do disco, e nada foi gravado.
   */
  conflicts?: { path: string; expected: string | null; actual: string | null }[]
}

export type { Connector, Endpoint, Environment, EnvironmentVariable, Flow, Scenario }

/** Erro de uma operação do lote: vira um item de `errors`, não uma exceção. */
export class ProjectOpError extends Error {}
