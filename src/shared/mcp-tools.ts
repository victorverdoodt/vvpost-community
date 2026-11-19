/**
 * As ferramentas do servidor MCP como o módulo MCP & IA mostra (docs/mcp.md). Um teste confere
 * esta lista com a que o servidor anuncia em tools/list, para a tela não ficar para trás.
 */
export const MCP_TOOL_SUMMARIES: readonly [name: string, what: string][] = [
  ['list_projects', 'Projetos do workspace e o Compartilhado, para escolher onde as outras ferramentas trabalham'],
  ['create_project', 'Cria um projeto no workspace (idempotente)'],
  ['get_api_catalog', 'Conectores com a herança resolvida, endpoints, ambientes e fluxos'],
  ['execute_dry_run', 'Roda cenários ou um endpoint pela herança e pela auth, sem gravar nada'],
  ['execute_flow', 'Roda um fluxo do workspace e devolve cada nó, sem gravar nada'],
  ['validate_body', 'Confere um corpo com o bodySchema do endpoint'],
  ['install_agent_rules', 'Grava no AGENTS.md (e no CLAUDE.md, que o importa) a regra de manter o VVPost em dia'],
  ['check_readiness', 'O que impede o projeto de rodar, por ambiente e de uma vez: segredo sem valor, variável, URL, API fora do ar'],
  ['get_schema', 'O JSON Schema v1 de cada tipo de arquivo'],
  ['get_source', 'Um conector, ambiente, fluxo ou doc como está no arquivo'],
  ['edit_project', 'Lote atômico de mudanças no projeto, com dryRun'],
  ['import_postman', 'Converte uma coleção do Postman em operações do projeto'],
  ['export_project', 'Pacote do VVPost, coleção do Postman, OpenAPI ou .vvpost.zip, sem nenhum valor de segredo'],
  ['import_bundle', 'Importa um pacote pelo mesmo plano da revisão do app, ou um .vvpost.zip como projeto novo'],
  ['import_openapi', 'Importa ou reimporta uma spec OpenAPI ou Swagger no catálogo'],
  ['sync_openapi', 'Sincroniza com a spec OpenAPI do código e relata o drift e o que quebra'],
  ['import_collection', 'Importa Insomnia, Bruno, HAR ou WSDL pela mesma revisão'],
  ['generate_docs', 'Documentação rica em Markdown do projeto, conector, endpoint ou request'],
  ['get_docs_project', 'O documento do projeto, o modelo e as páginas em docs/'],
  ['save_docs_project', 'Grava o documento do projeto e o modelo (vvpost.docs.json)'],
  ['write_docs_page', 'Grava uma página .md ou um diagrama .mmd em docs/'],
  ['fix_diagrams', 'Corrige os diagramas de arquitetura que divergem do catálogo (elemento que falta, que sobrou, relações)'],
  ['save_docs_template', 'Salva um modelo de documentação do projeto'],
  ['find_references', 'Onde um nome aparece: páginas, documento e campos de fluxos e conectores'],
  ['replace_references', 'Troca um nome em todo o projeto num lote: chaves e textos do catálogo e páginas'],
  ['export_docs', 'Grava a documentação em PDF (com o modelo, o logo e os diagramas), Markdown ou site HTML'],
  ['lint_project', 'Regras de estilo e erros comuns do projeto (ruleset do time ou vvpost:recommended), com code e hint'],
  ['get_brand', 'Tokens da marca (cores, fontes, espaçamentos) numa linha por token, antes de mexer no frontend'],
  ['list_webhook_events', 'Eventos recebidos pelo servidor de webhooks'],
  ['get_webhook_event', 'Um evento inteiro, sanitizado']
]

/**
 * Perfis do --tools: o servidor anuncia só as ferramentas do perfil. A definição de cada ferramenta
 * vai em todo turno do agente (nas CLIs que não adiam as do MCP, com o schema inteiro), e um passo
 * que só lê ou só mexe no contrato usa poucas delas. `tudo` (o padrão) anuncia todas.
 */
export const MCP_TOOL_PROFILES = {
  leitura: ['list_projects', 'get_api_catalog', 'get_source', 'find_references', 'get_schema', 'generate_docs', 'get_docs_project', 'lint_project', 'get_brand'],
  contrato: [
    'list_projects',
    'check_readiness',
    'get_api_catalog',
    'get_source',
    'find_references',
    'replace_references',
    'edit_project',
    'execute_dry_run',
    'execute_flow',
    'validate_body',
    'sync_openapi',
    'get_schema',
    'lint_project',
    'get_docs_project',
    'write_docs_page',
    'fix_diagrams',
    'export_docs',
    'get_brand'
  ],
  docs: [
    'list_projects',
    'get_api_catalog',
    'get_source',
    'find_references',
    'replace_references',
    'edit_project',
    'generate_docs',
    'get_docs_project',
    'save_docs_project',
    'write_docs_page',
    'fix_diagrams',
    'save_docs_template',
    'export_docs',
    'lint_project',
    'get_brand'
  ]
} as const satisfies Record<string, readonly string[]>

export type McpToolProfile = keyof typeof MCP_TOOL_PROFILES

/**
 * O que o --tools pede: perfis e nomes de ferramentas, separados por vírgula (`contrato,get_brand`).
 * `tudo` vale todas (null). Um nome que não é perfil nem ferramenta volta em `unknown`.
 */
export function resolveToolSelection(spec: string, known: readonly string[]): { tools: Set<string> | null; unknown: string[] } {
  const tools = new Set<string>()
  const unknown: string[] = []
  for (const item of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (item === 'tudo') return { tools: null, unknown: [] }
    if (item in MCP_TOOL_PROFILES) for (const name of MCP_TOOL_PROFILES[item as McpToolProfile]) tools.add(name)
    else if (known.includes(item)) tools.add(item)
    else unknown.push(item)
  }
  return { tools, unknown }
}

/**
 * Termos em inglês no fim da descrição de algumas ferramentas, para a busca de ferramentas adiadas: o Codex acha a
 * ferramenta por BM25 em inglês (nome, título, descrição), e as descrições são em português. Só os termos que o nome
 * da ferramenta não traz; cada um custa caracteres do tools/list.
 */
export const MCP_SEARCH_TERMS: Partial<Record<string, string>> = {
  get_api_catalog: 'API catalog, connectors, environments',
  execute_dry_run: 'call API, HTTP request, run tests, scenarios, credentials vault',
  execute_flow: 'run workflow, API test',
  check_readiness: 'health check, preflight, doctor, missing secrets',
  edit_project: 'edit API contract, endpoint, schema, scenario, test, docs',
  find_references: 'search, where used',
  replace_references: 'rename field, search and replace',
  generate_docs: 'documentation, API reference',
  write_docs_page: 'write documentation page, markdown, diagram',
  fix_diagrams: 'architecture diagram, C4, mermaid',
  export_docs: 'export documentation, PDF, site',
  get_brand: 'design tokens, colors, fonts, theme, frontend',
  lint_project: 'lint, validate, style rules',
  sync_openapi: 'OpenAPI drift, breaking changes, spec',
  install_agent_rules: 'AGENTS.md, CLAUDE.md, agent rules'
}
