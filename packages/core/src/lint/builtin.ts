/**
 * Os rulesets embutidos, no mesmo formato do arquivo do time. `vvpost:recommended` olha o workspace
 * (conectores, endpoints, cenários, ambientes, fluxos e páginas de docs/); `spectral:oas` é um
 * recorte das regras de OpenAPI do Spectral, aplicado à spec que o VVPost exporta. A lista com a
 * explicação de cada regra está em docs/lint.md.
 */

const ENDPOINTS = '$.connectors[*].endpoints[*]'
const NAMED = ['$.connectors[*]', ENDPOINTS, `${ENDPOINTS}.scenarios[*]`, '$.flows[*]', '$.environments[*]']

const VVPOST_RULES = {
  // --- Estilo e padronização ---
  'connector-description': {
    description: 'Conector com descrição',
    message: 'conector sem descrição',
    hint: 'Escreva em "description" para que serve o conector: é o começo da documentação dele.',
    severity: 'warn',
    given: '$.connectors[*]',
    then: { field: 'description', function: 'truthy' }
  },
  'endpoint-description': {
    description: 'Endpoint com descrição',
    message: 'endpoint sem descrição',
    hint: 'Escreva em "description" o que o endpoint faz e quando usar; a documentação e o agente partem dela.',
    severity: 'warn',
    given: ENDPOINTS,
    then: { field: 'description', function: 'truthy' }
  },
  'path-kebab-case': {
    description: 'Caminho em minúsculas, com hífen entre as palavras',
    message: 'caminho {{value}} fora do kebab-case',
    hint: 'Use minúsculas e hífen nos trechos fixos do caminho (/pedidos-pendentes); os parâmetros ficam em {nome}.',
    severity: 'warn',
    given: `${ENDPOINTS}.path`,
    then: { function: 'pattern', functionOptions: { match: '^(\\/([a-z0-9][a-z0-9.~-]*|\\{[^{}/]+\\}|\\{\\{[^{}/]+\\}\\}|:[A-Za-z_]\\w*))*\\/?(\\?.*)?$' } }
  },
  'path-no-trailing-slash': {
    description: 'Caminho sem barra no fim',
    message: 'caminho {{value}} termina com /',
    hint: 'Tire a barra do fim: /pedidos e /pedidos/ viram rotas diferentes em muitos servidores.',
    severity: 'warn',
    given: `${ENDPOINTS}.path`,
    then: { function: 'pattern', functionOptions: { notMatch: '.+\\/$' } }
  },
  'path-no-query-string': {
    description: 'Query fora do caminho',
    message: 'caminho {{value}} com query string',
    hint: 'Passe os parâmetros de query em "query" do endpoint, não no caminho.',
    severity: 'warn',
    given: `${ENDPOINTS}.path`,
    then: { function: 'pattern', functionOptions: { notMatch: '\\?' } }
  },
  'path-params-camel-case': {
    description: 'Parâmetros do caminho em camelCase',
    message: 'parâmetro do caminho {{value}} fora do camelCase',
    hint: 'Escreva os parâmetros como {pedidoId}. Ligue a regra no ruleset do time se for a convenção.',
    severity: 'info',
    recommended: false,
    given: `${ENDPOINTS}.path`,
    then: { function: 'pattern', functionOptions: { notMatch: '(^|\\/)\\{(?![a-z][a-zA-Z0-9]*\\})(?!\\{)[^{}\\/]+\\}(?=\\/|$)' } }
  },
  'name-capitalized': {
    description: 'Nome começando com maiúscula',
    message: 'nome {{value}} começa com minúscula',
    hint: 'Comece o nome com maiúscula: é o título na documentação e no catálogo.',
    severity: 'info',
    recommended: false,
    given: NAMED,
    then: { field: 'name', function: 'pattern', functionOptions: { match: '/^[\\p{Lu}\\p{N}{]/u' } }
  },
  'flow-description': {
    description: 'Fluxo com descrição',
    message: 'fluxo sem descrição',
    hint: 'Diga em "description" o processo que o fluxo cobre; ele aparece no mapa da documentação.',
    severity: 'info',
    given: '$.flows[*]',
    then: { field: 'description', function: 'truthy' }
  },
  // --- Erros comuns ---
  'endpoint-example': {
    description: 'Endpoint com resposta de exemplo',
    message: 'endpoint sem resposta de exemplo',
    hint: 'Salve uma resposta de exemplo (examples): a documentação mostra, o mock serve e o matchesExample confere.',
    severity: 'warn',
    given: `$.connectors[*].endpoints[?(!@.plugin)]`,
    then: [
      { field: 'examples', function: 'truthy' },
      { field: 'examples', function: 'length', functionOptions: { min: 1 } }
    ]
  },
  'endpoint-success-example': {
    description: 'Exemplo de sucesso entre as respostas de exemplo',
    message: 'nenhuma resposta de exemplo com status 2xx',
    hint: 'Inclua o exemplo da resposta de sucesso: é o que o mock devolve por padrão.',
    severity: 'info',
    given: `$.connectors[*].endpoints[?(!@.plugin)]`,
    then: { field: 'examples', function: 'schema', functionOptions: { schema: { type: 'array', contains: { type: 'object', properties: { status: { minimum: 200, maximum: 299 } } } } } }
  },
  'endpoint-scenario': {
    description: 'Endpoint com cenário de teste',
    message: 'endpoint sem cenário de teste',
    hint: 'Crie ao menos um cenário com asserções: é o que o vvpost run roda no CI.',
    severity: 'warn',
    given: ENDPOINTS,
    then: [
      { field: 'scenarios', function: 'truthy' },
      { field: 'scenarios', function: 'length', functionOptions: { min: 1 } }
    ]
  },
  'endpoint-requires-auth': {
    description: 'Endpoint que diz se exige autenticação',
    message: 'endpoint sem requiresAuth',
    hint: 'Marque "requiresAuth": true se ele exige credencial, ou false se é público: o vvpost run confere que sem credencial ele dá 401/403, ou que funciona. A importação da OpenAPI preenche pelo security da operação.',
    severity: 'info',
    given: `$.connectors[*].endpoints[?(!@.plugin)]`,
    then: { field: 'requiresAuth', function: 'defined' }
  },
  'scenario-status-assertion': {
    description: 'Cenário que confere o status',
    message: 'cenário sem asserção de status',
    hint: 'Acrescente uma asserção com target "status": sem ela, um 500 com corpo parecido passa.',
    severity: 'info',
    given: `${ENDPOINTS}.scenarios[*]`,
    then: { field: 'assertions', function: 'schema', functionOptions: { schema: { type: 'array', contains: { type: 'object', properties: { target: { const: 'status' } }, required: ['target'] } } } }
  },
  'example-schema': {
    description: 'Resposta de exemplo com schema',
    message: 'resposta de exemplo sem schema',
    hint: 'Defina o "schema" do exemplo: a documentação mostra os campos e o vvpost validate confere o exemplo com ele.',
    severity: 'warn',
    given: `${ENDPOINTS}.examples[?(@.body !== undefined && @.body !== null && @.body !== '')]`,
    then: { field: 'schema', function: 'truthy' }
  },
  'secret-not-marked': {
    description: 'Variável com nome de credencial marcada como segredo',
    message: 'variável com nome de credencial sem isSecret',
    hint: 'Marque "isSecret": true para o valor ir ao cofre e sair dos exports e do Git.',
    severity: 'warn',
    given: '$.environments[*].variables[?(@property.match(/(secret|senha|password|passwd|token|api[-_]?key|private[-_]?key|credential)$/i))]',
    then: { field: 'isSecret', function: 'truthy' }
  },
  'connector-auth-consistent': {
    description: 'Endpoints do conector usando a mesma auth',
    message: '{{error}}',
    severity: 'warn',
    given: '$.auth[*]',
    then: { function: 'authConsistency' }
  },
  'doc-references-endpoint': {
    description: 'Página de documentação ligada ao catálogo',
    message: 'a página não cita nenhum endpoint',
    hint: 'Ligue a página ao que ela explica: {{> endpoint <conector>/<endpoint>}}, {{> connector <id>}} ou o id <conector>/<endpoint> no texto.',
    severity: 'info',
    given: '$.docs[*]',
    then: { field: 'references.endpoints', function: 'length', functionOptions: { min: 1 } }
  },
  // --- Documentação de arquitetura que ficou velha ($.drift, docs/documentation.md) ---
  ...drift('c4-binding-unknown', 'Anotação do C4 ligada a algo que existe', 'error'),
  ...drift('c4-connector-missing', 'Conector do projeto num diagrama C4', 'warn'),
  ...drift('c4-flow-missing', 'Fluxo no diagrama C4 que pede todos (cover flows)', 'warn'),
  ...drift('c4-relation-missing', 'Relação no C4 entre o fluxo e os conectores que ele chama', 'warn'),
  ...drift('c4-relation-stale', 'Relação no C4 que o fluxo não faz mais', 'info'),
  ...drift('c4-relation-unknown-element', 'Relação do C4 entre elementos declarados', 'warn'),
  ...drift('c4-element-ambiguous', 'Elemento do C4 com nome de um só item do catálogo', 'hint'),
  ...drift('doc-unknown-reference', 'Citação no texto de conector, endpoint ou fluxo que existe', 'warn'),
  ...drift('doc-code-map', 'Cópia do mapa do código (<!-- vvpost:codemap pasta -->) com as áreas e os arquivos que o código tem', 'warn'),
  ...drift('doc-stale-since-change', 'Página de arquitetura revisada depois da última mudança estrutural do que ela mostra', 'info'),
  // --- Marca e produto: tokens e o código do frontend ($.brand, docs/brand.md) ---
  ...brand('tokens-invalid', 'Arquivo de tokens no formato DTCG, com alias que resolvem e tipos válidos', 'error'),
  ...brand('tokens-contrast', 'Par de cores de $extensions.vvpost.contrast com o contraste mínimo em cada modo', 'error'),
  ...brand('brand-code-drift', 'Tema no código (variável CSS ou createTheme) com o valor do token mapeado em $extensions.vvpost.code', 'error'),
  ...brand('brand-hardcoded-color', 'Cor da marca usada pelo token, não escrita à mão', 'warn'),
  ...brand('brand-unknown-color', 'Cor no código que é da marca', 'warn'),
  ...brand('brand-font', 'Fonte no código que está nos tokens da marca', 'warn')
}

/** Regra que reporta um tipo de achado da marca; a mensagem e o hint vêm do item. */
function brand(code: string, description: string, severity: string): Record<string, unknown> {
  return { [code]: { description, severity, given: `$.brand[?(@.code == '${code}')]`, then: { function: 'drift' } } }
}

/** Regra que reporta um tipo de item de drift; a mensagem e o hint vêm do item. */
function drift(code: string, description: string, severity: string): Record<string, unknown> {
  return { [code]: { description, severity, given: `$.drift[?(@.code == '${code}')]`, then: { function: 'drift' } } }
}

const OPERATIONS = '$.paths[*][get,put,post,delete,options,head,patch,trace]'

/** Recorte das regras recomendadas do spectral:oas (mesmos nomes), para a spec exportada. */
const OAS_RULES = {
  'info-contact': {
    description: 'Info object must have "contact" object.',
    message: 'a spec não tem info.contact',
    severity: 'warn',
    given: '$.info',
    then: { field: 'contact', function: 'truthy' }
  },
  'info-description': {
    description: 'Info "description" must be present and non-empty string.',
    message: 'a spec não tem info.description',
    hint: 'A descrição da spec sai da descrição do pacote ou do conector raiz.',
    severity: 'warn',
    given: '$.info',
    then: { field: 'description', function: 'truthy' }
  },
  'oas3-api-servers': {
    description: 'OpenAPI "servers" must be present and non-empty array.',
    message: 'a spec saiu sem servers',
    hint: 'Defina a URL base (baseUrl) no conector raiz.',
    severity: 'warn',
    given: '$',
    then: [
      { field: 'servers', function: 'truthy' },
      { field: 'servers', function: 'length', functionOptions: { min: 1 } }
    ]
  },
  'openapi-tags': {
    description: 'OpenAPI object must have non-empty "tags" array.',
    message: 'a spec não tem tags',
    severity: 'warn',
    recommended: false,
    given: '$',
    then: [{ field: 'tags', function: 'truthy' }]
  },
  'tag-description': {
    description: 'Tag object must have "description".',
    message: 'tag sem descrição',
    hint: 'A tag é o conector: escreva a descrição dele.',
    severity: 'warn',
    given: '$.tags[*]',
    then: { field: 'description', function: 'truthy' }
  },
  'operation-description': {
    description: 'Operation "description" must be present and non-empty string.',
    message: 'operação sem descrição',
    severity: 'warn',
    given: OPERATIONS,
    then: { field: 'description', function: 'truthy' }
  },
  'operation-operationId': {
    description: 'Operation must have "operationId".',
    message: 'operação sem operationId',
    severity: 'warn',
    given: OPERATIONS,
    then: { field: 'operationId', function: 'truthy' }
  },
  'operation-success-response': {
    description: 'Operation must have at least one "2xx" or "3xx" response.',
    message: 'operação sem resposta 2xx ou 3xx',
    hint: 'As respostas da spec saem das respostas de exemplo do endpoint: salve a de sucesso.',
    severity: 'warn',
    given: OPERATIONS,
    then: { field: 'responses', function: 'oasOpSuccessResponse' }
  },
  'operation-tags': {
    description: 'Operation must have non-empty "tags" array.',
    message: 'operação sem tag',
    severity: 'warn',
    recommended: false,
    given: OPERATIONS,
    then: { field: 'tags', function: 'truthy' }
  },
  'path-params': {
    description: 'Path parameters must be defined and valid.',
    message: '{{error}}',
    hint: 'Os parâmetros de caminho saem das variáveis {nome} do path do endpoint; dois endpoints no mesmo caminho precisam usar o mesmo nome de variável.',
    severity: 'error',
    given: '$.paths',
    then: { function: 'oasPathParam' }
  },
  'operation-parameters': {
    description: 'Operation parameters are unique and non-repeating.',
    message: '{{error}}',
    hint: 'Os parâmetros vêm da query e dos headers do endpoint e do conector: deixe cada nome uma vez só.',
    severity: 'warn',
    given: `${OPERATIONS}.parameters`,
    then: { function: 'oasOpParams' }
  },
  'path-keys-no-trailing-slash': {
    description: 'Path must not end with slash.',
    message: 'caminho {{property}} termina com /',
    severity: 'warn',
    given: '$.paths',
    then: { field: '@key', function: 'pattern', functionOptions: { notMatch: '.+\\/$' } }
  },
  'no-script-tags-in-markdown': {
    description: 'Markdown descriptions must not have "<script>" tags.',
    message: 'descrição com <script>',
    severity: 'warn',
    given: '$..description',
    then: { function: 'pattern', functionOptions: { notMatch: '<script' } }
  },
  'no-eval-in-markdown': {
    description: 'Markdown descriptions must not have "eval(".',
    message: 'descrição com eval(',
    severity: 'warn',
    given: '$..description',
    then: { function: 'pattern', functionOptions: { notMatch: 'eval\\(' } }
  },
  'duplicated-entry-in-enum': {
    description: 'Enum values must not have duplicate entry.',
    message: 'enum com valor repetido',
    severity: 'warn',
    given: '$..enum',
    then: { function: 'uniqueItems' }
  }
}

export const BUILTIN_RULESETS: Record<string, Record<string, unknown>> = {
  'vvpost:recommended': { formats: ['vvpost'], rules: VVPOST_RULES },
  'vvpost:all': { extends: [['vvpost:recommended', 'all']] },
  'spectral:oas': { formats: ['oas3'], rules: OAS_RULES }
}
