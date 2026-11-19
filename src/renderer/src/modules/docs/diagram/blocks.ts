import type { DiagramBlock } from '@shared/ipc'

/**
 * Paleta do editor de diagramas: blocos prontos (como as formas do draw.io) que entram no cursor
 * ou são arrastados para o código, e modelos que começam um diagrama inteiro. Os plugins somam
 * blocos e pacotes de ícones (contributes.diagrams).
 */

/** Tipo do diagrama pela primeira linha útil: escolhe que grupos da paleta vêm primeiro. */
export function diagramKind(code: string): string {
  const first = code
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('%%'))
  const word = (first ?? '').split(/\s+/)[0]!.toLowerCase()
  if (word === 'graph' || word === 'flowchart') return 'flowchart'
  if (word.startsWith('c4')) return 'c4'
  if (word === 'architecture-beta') return 'architecture'
  if (word === 'statediagram-v2' || word === 'statediagram') return 'state'
  return word
}

/** Grupo da paleta para cada tipo de diagrama. */
const KIND_CATEGORY: Record<string, string> = {
  flowchart: 'Fluxograma',
  sequencediagram: 'Sequência',
  c4: 'C4',
  architecture: 'Arquitetura',
  classdiagram: 'Classes',
  state: 'Estados',
  erdiagram: 'Entidade-relacionamento'
}
export const categoryForKind = (kind: string): string | undefined => KIND_CATEGORY[kind]

export const BUILTIN_BLOCKS: readonly DiagramBlock[] = [
  // Fluxograma
  { category: 'Fluxograma', title: 'Início / fim', code: '  inicio([Início])' },
  { category: 'Fluxograma', title: 'Processo', code: '  passo[Processo]' },
  { category: 'Fluxograma', title: 'Decisão', code: '  decisao{Decisão?}' },
  {
    category: 'Fluxograma',
    title: 'Entrada / saída',
    code: '  dados[/Entrada/]'
  },
  { category: 'Fluxograma', title: 'Banco de dados', code: '  banco[(Banco)]' },
  {
    category: 'Fluxograma',
    title: 'Subprocesso',
    code: '  sub[[Subprocesso]]'
  },
  {
    category: 'Fluxograma',
    title: 'Documento',
    code: '  doc@{ shape: doc, label: "Documento" }'
  },
  {
    category: 'Fluxograma',
    title: 'Fila',
    code: '  fila@{ shape: das, label: "Fila" }'
  },
  {
    category: 'Fluxograma',
    title: 'Nó com ícone',
    code: '  servico@{ icon: "vv:servidor", form: "rounded", label: "Serviço", pos: "b" }',
    icon: 'vv:servidor'
  },
  { category: 'Fluxograma', title: 'Ligação', code: '  a --> b' },
  {
    category: 'Fluxograma',
    title: 'Ligação com texto',
    code: '  a -->|sim| b'
  },
  { category: 'Fluxograma', title: 'Ligação tracejada', code: '  a -.-> b' },
  {
    category: 'Fluxograma',
    title: 'Grupo',
    code: '  subgraph grupo [Grupo]\n    direction TB\n    x[Item]\n  end'
  },
  {
    category: 'Fluxograma',
    title: 'Estilo de destaque',
    code: '  classDef destaque fill:#0b5fff,stroke:#0b5fff,color:#fff\n  class passo destaque'
  },
  // Sequência
  { category: 'Sequência', title: 'Participante', code: '  participant API' },
  { category: 'Sequência', title: 'Ator', code: '  actor Usuario as Usuário' },
  {
    category: 'Sequência',
    title: 'Mensagem',
    code: '  Usuario->>API: Requisição'
  },
  {
    category: 'Sequência',
    title: 'Resposta',
    code: '  API-->>Usuario: Resposta'
  },
  {
    category: 'Sequência',
    title: 'Mensagem assíncrona',
    code: '  API-)Fila: Evento'
  },
  {
    category: 'Sequência',
    title: 'Ativação',
    code: '  activate API\n  API->>Banco: Consulta\n  deactivate API'
  },
  {
    category: 'Sequência',
    title: 'Nota',
    code: '  Note over Usuario,API: Observação'
  },
  {
    category: 'Sequência',
    title: 'Repetição',
    code: '  loop A cada minuto\n    API->>API: Verifica\n  end'
  },
  {
    category: 'Sequência',
    title: 'Alternativa',
    code: '  alt Sucesso\n    API-->>Usuario: 200\n  else Erro\n    API-->>Usuario: 4xx\n  end'
  },
  {
    category: 'Sequência',
    title: 'Opcional',
    code: '  opt Com cache\n    API->>Cache: Lê\n  end'
  },
  // C4
  {
    category: 'C4',
    title: 'Pessoa',
    code: '  Person(usuario, "Usuário", "Quem usa o sistema")'
  },
  {
    category: 'C4',
    title: 'Sistema',
    code: '  System(sistema, "Sistema", "O que ele faz")'
  },
  {
    category: 'C4',
    title: 'Sistema externo',
    code: '  System_Ext(externo, "Sistema externo", "Integração")'
  },
  {
    category: 'C4',
    title: 'Contêiner',
    code: '  Container(api, "API", "Node.js", "Expõe os endpoints")'
  },
  {
    category: 'C4',
    title: 'Banco (contêiner)',
    code: '  ContainerDb(banco, "Banco", "PostgreSQL", "Guarda os dados")'
  },
  {
    category: 'C4',
    title: 'Fila (contêiner)',
    code: '  ContainerQueue(fila, "Fila", "Kafka", "Eventos")'
  },
  {
    category: 'C4',
    title: 'Componente',
    code: '  Component(comp, "Componente", "Módulo", "Responsabilidade")'
  },
  {
    category: 'C4',
    title: 'Relação',
    code: '  Rel(usuario, sistema, "Usa", "HTTPS")'
  },
  {
    category: 'C4',
    title: 'Fronteira do sistema',
    code: '  System_Boundary(fronteira, "Sistema") {\n    Container(app, "App", "React")\n  }'
  },
  // Arquitetura (com ícones)
  {
    category: 'Arquitetura',
    title: 'Grupo',
    code: '  group nuvem(cloud)[Nuvem]'
  },
  {
    category: 'Arquitetura',
    title: 'Serviço',
    code: '  service servidor(vv:servidor)[Servidor] in nuvem',
    icon: 'vv:servidor'
  },
  {
    category: 'Arquitetura',
    title: 'Banco',
    code: '  service banco(vv:banco)[Banco] in nuvem',
    icon: 'vv:banco'
  },
  {
    category: 'Arquitetura',
    title: 'Gateway',
    code: '  service gateway(vv:gateway)[Gateway] in nuvem',
    icon: 'vv:gateway'
  },
  {
    category: 'Arquitetura',
    title: 'Fila',
    code: '  service fila(vv:fila)[Fila] in nuvem',
    icon: 'vv:fila'
  },
  {
    category: 'Arquitetura',
    title: 'Usuário',
    code: '  service usuario(vv:usuario)[Usuário]',
    icon: 'vv:usuario'
  },
  {
    category: 'Arquitetura',
    title: 'Junção',
    code: '  junction juncao in nuvem'
  },
  {
    category: 'Arquitetura',
    title: 'Ligação',
    code: '  servidor:R --> L:banco'
  },
  // Classes, estados e ER
  {
    category: 'Classes',
    title: 'Classe',
    code: '  class Pedido {\n    +String id\n    +total() Number\n  }'
  },
  { category: 'Classes', title: 'Herança', code: '  Base <|-- Pedido' },
  { category: 'Classes', title: 'Composição', code: '  Pedido *-- Item' },
  { category: 'Estados', title: 'Estado', code: '  Pendente' },
  {
    category: 'Estados',
    title: 'Transição',
    code: '  Pendente --> Pago: pagamento aprovado'
  },
  {
    category: 'Estados',
    title: 'Início e fim',
    code: '  [*] --> Pendente\n  Pago --> [*]'
  },
  {
    category: 'Entidade-relacionamento',
    title: 'Entidade',
    code: '  CLIENTE {\n    string id PK\n    string nome\n  }'
  },
  {
    category: 'Entidade-relacionamento',
    title: 'Um para muitos',
    code: '  CLIENTE ||--o{ PEDIDO : faz'
  }
]

export interface DiagramTemplate {
  id: string
  title: string
  code: string
}

export const DIAGRAM_TEMPLATES: readonly DiagramTemplate[] = [
  {
    id: 'flowchart',
    title: 'Fluxograma',
    code: 'flowchart LR\n  inicio([Início]) --> passo[Processo]\n  passo --> decisao{Deu certo?}\n  decisao -->|sim| fim([Fim])\n  decisao -->|não| passo'
  },
  {
    id: 'sequence',
    title: 'Sequência',
    code: 'sequenceDiagram\n  actor Usuario as Usuário\n  participant API\n  participant Banco\n  Usuario->>API: POST /pedidos\n  API->>Banco: grava\n  Banco-->>API: ok\n  API-->>Usuario: 201 Created'
  },
  {
    id: 'c4-context',
    title: 'C4: contexto',
    code: 'C4Context\n  title Contexto do sistema\n  Person(usuario, "Usuário", "Quem usa o sistema")\n  System(sistema, "Sistema", "O que ele faz")\n  System_Ext(externo, "Sistema externo", "Integração")\n  Rel(usuario, sistema, "Usa", "HTTPS")\n  Rel(sistema, externo, "Chama", "REST")'
  },
  {
    id: 'c4-container',
    title: 'C4: contêineres',
    code: 'C4Container\n  title Contêineres\n  Person(usuario, "Usuário")\n  System_Boundary(sistema, "Sistema") {\n    Container(web, "Web", "React", "Interface")\n    Container(api, "API", "Node.js", "Regras de negócio")\n    ContainerDb(banco, "Banco", "PostgreSQL", "Dados")\n  }\n  Rel(usuario, web, "Usa")\n  Rel(web, api, "Chama", "JSON/HTTPS")\n  Rel(api, banco, "Lê e grava", "SQL")'
  },
  {
    id: 'architecture',
    title: 'Arquitetura com ícones',
    code: 'architecture-beta\n  group nuvem(cloud)[Nuvem]\n  service usuario(vv:usuario)[Usuário]\n  service gateway(vv:gateway)[Gateway] in nuvem\n  service api(vv:servidor)[API] in nuvem\n  service banco(vv:banco)[Banco] in nuvem\n  usuario:R --> L:gateway\n  gateway:R --> L:api\n  api:B --> T:banco'
  },
  {
    id: 'class',
    title: 'Classes',
    code: 'classDiagram\n  class Pedido {\n    +String id\n    +total() Number\n  }\n  class Item\n  Pedido *-- Item'
  },
  {
    id: 'state',
    title: 'Estados',
    code: 'stateDiagram-v2\n  [*] --> Pendente\n  Pendente --> Pago: aprovado\n  Pendente --> Cancelado: recusado\n  Pago --> [*]'
  },
  {
    id: 'er',
    title: 'Entidade-relacionamento',
    code: 'erDiagram\n  CLIENTE ||--o{ PEDIDO : faz\n  PEDIDO ||--|{ ITEM : contém'
  },
  {
    id: 'gantt',
    title: 'Cronograma (Gantt)',
    code: 'gantt\n  title Entregas\n  dateFormat YYYY-MM-DD\n  section API\n  Desenho :a1, 2026-11-02, 5d\n  Implementação :after a1, 10d'
  },
  {
    id: 'mindmap',
    title: 'Mapa mental',
    code: 'mindmap\n  root((Produto))\n    API\n      Pedidos\n      Pagamentos\n    Integrações\n      ERP'
  },
  {
    id: 'timeline',
    title: 'Linha do tempo',
    code: 'timeline\n  title Versões\n  2026-01 : v1 pública\n  2026-06 : v2 com webhooks'
  }
]
