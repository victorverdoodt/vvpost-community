# Lint de regras

O `vvpost validate` confere se os arquivos estão certos: JSON, schemas, herança e se a
documentação aponta para o que existe. O lint confere se estão bons: estilo e padronização (nomes,
descrições, convenções de caminho) e os erros comuns que deixam a documentação e os testes pela
metade (endpoint sem exemplo, sem cenário, resposta sem schema, credencial fora do cofre). As
regras são escritas no formato do [Spectral](https://github.com/stoplightio/spectral), com
JSONPath, e o time guarda as próprias no projeto.

O lint roda nos três lugares de sempre:

| Onde | Como |
| --- | --- |
| App | Painel **Lint** no Inspector do Catálogo. Clicar num achado abre o conector, o endpoint, o cenário, o ambiente ou o fluxo dele. Relê junto com o catálogo. |
| CLI | `vvpost lint`, com saída em texto, JSON, JUnit e SARIF ([CLI](cli.md#vvpost-lint)), e `vvpost validate --lint`. |
| MCP | A ferramenta `lint_project` e, depois de cada escrita, os achados novos que a escrita trouxe ([MCP](mcp.md)). |

## Ruleset padrão: `vvpost:recommended`

Sem ruleset no projeto, valem estas regras. A severidade padrão de cada uma está na coluna; o
ruleset do time troca.

| Regra | Nível | O que confere |
| --- | --- | --- |
| `connector-description` | aviso | Conector com `description`. |
| `endpoint-description` | aviso | Endpoint com `description`. |
| `path-kebab-case` | aviso | Trechos fixos do caminho em minúsculas com hífen (`/pedidos-pendentes/{id}`). |
| `path-no-trailing-slash` | aviso | Caminho sem `/` no fim. |
| `path-no-query-string` | aviso | Query em `query`, não no caminho. |
| `endpoint-example` | aviso | Endpoint HTTP com pelo menos uma [resposta de exemplo](mock.md). |
| `endpoint-scenario` | aviso | Endpoint com pelo menos um [cenário de teste](tests.md). |
| `example-schema` | aviso | Resposta de exemplo com corpo tem `schema`. |
| `secret-not-marked` | aviso | Variável de ambiente com nome de credencial (`...TOKEN`, `...SECRET`, `password`, `apiKey`...) marcada `isSecret`. |
| `endpoint-success-example` | info | Entre as respostas de exemplo, uma com status 2xx. |
| `endpoint-requires-auth` | info | Endpoint HTTP com `requiresAuth` (exige credencial ou é público), que o [gate de acesso](tests.md#gate-de-acesso-requiresauth) do `vvpost run` confere. |
| `scenario-status-assertion` | info | Cenário com uma asserção de `status`. |
| `flow-description` | info | Fluxo com `description`. |
| `connector-auth-consistent` | aviso | Endpoints de um conector usando a mesma auth. Com auth no conector (ou herdada), acusa o endpoint que manda o header dela (que troca a credencial só ali) ou outro header de credencial, e o cenário que troca esse header. Sem auth no conector, acusa quando só parte dos endpoints manda credencial no header, quando cada um usa um header diferente ou quando todos mandam à mão: o caminho é a auth do conector com a credencial numa variável segredo. |
| `doc-references-endpoint` | info | Página `.md` de `docs/` que cita algum endpoint: por diretiva (`{{> endpoint ...}}`, `{{> connector ...}}`, `{{> reference}}`), pelo id `<conector>/<endpoint>` ou por `MÉTODO /caminho` no texto. Uma página de arquitetura pode não citar nenhum; o nível é info para isso. |
| `c4-binding-unknown` | erro | Diagrama C4 com anotação `%% vvpost:bind` para um conector ou fluxo que não existe mais ([C4 que não envelhece](documentation.md#diagramas-c4-que-não-envelhecem)). |
| `c4-connector-missing` | aviso | Conector do projeto com endpoint que nenhum diagrama C4 mostra. |
| `c4-flow-missing` | aviso | Fluxo fora do diagrama C4 com `%% vvpost:cover flows`. |
| `c4-relation-missing` | aviso | Elemento de um fluxo sem relação com um conector que o fluxo chama. |
| `c4-relation-unknown-element` | aviso | `Rel` com um alias que o diagrama não declara. |
| `doc-code-map` | aviso | Cópia do mapa do código (`<!-- vvpost:codemap <pasta> -->`) numa página ou no `AGENTS.md`/`CLAUDE.md` da raiz que não bate com as áreas e os arquivos da pasta. |
| `doc-unknown-reference` | aviso | Página que cita em código inline um endpoint, cenário, conector ou fluxo que não existe mais. |
| `c4-relation-stale` | info | Relação de um fluxo com um conector que ele não chama mais. |
| `doc-stale-since-change` | info | Página de arquitetura (diagrama ligado ao catálogo, ou ADR) cujo conector ou fluxo mudou de estrutura depois do último commit dela, pelo histórico do Git. |
| `tokens-invalid` | erro | Arquivo de tokens da [marca](brand.md) fora do formato DTCG: alias que não resolve, ciclo, tipo ou valor inválido, `$extensions.vvpost` malformado. |
| `tokens-contrast` | erro | Par de cores de `$extensions.vvpost.contrast` abaixo do mínimo, em cada modo. |
| `brand-code-drift` | erro | Variável CSS ou chave do `createTheme` mapeada em `$extensions.vvpost.code` com valor diferente do token. |
| `brand-hardcoded-color` | aviso | Cor escrita à mão no código que é o valor de um token; o `hint` diz como usar o token. |
| `brand-unknown-color` | aviso | Cor escrita à mão que não é da marca; o `hint` diz o token mais próximo. |
| `brand-font` | aviso | `font-family` ou `fontFamily` fora das fontes dos tokens. |
| `brand-spacing` | aviso | `margin`, `padding` ou `gap` em px/rem fora da escala de espaçamento dos tokens; o `hint` diz o valor mais perto. |
| `c4-element-ambiguous` | dica | Elemento do C4 com o nome de mais de um item do catálogo. |
| `path-params-camel-case` | desligada | Parâmetros do caminho em camelCase (`{pedidoId}`). |
| `name-capitalized` | desligada | Nomes de conector, endpoint, cenário, fluxo e ambiente começando com maiúscula. |

As desligadas entram com `extends: [[vvpost:recommended, all]]` (o mesmo que `vvpost:all`) ou
ligando uma a uma no ruleset.

## Ruleset do time

O lint procura, na pasta do projeto, `.vvpost/ruleset.yaml` (ou `.yml`, ou `.json`) e, para quem já
usa o Spectral, `.spectral.yaml`. Num workspace com projetos, o projeto sem ruleset usa o da raiz.
`vvpost lint --ruleset <arquivo>` usa outro.

```yaml
extends:
  - vvpost:recommended          # ou [vvpost:recommended, all], ou [vvpost:recommended, off]
  - ./regras-da-empresa.yaml    # outro ruleset do repositório, relativo a este arquivo
rules:
  endpoint-description: error   # trocar a severidade: error, warn, info, hint ou off (ou 0 a 3, ou false)
  endpoint-scenario: off
  path-params-camel-case: true  # ligar uma regra desligada, na severidade dela
  id-do-endpoint-kebab:
    description: Id de endpoint em kebab-case
    message: "id {{value}} fora do kebab-case"
    hint: Renomeie com replace_references para não quebrar a documentação.
    severity: warn
    given: $.connectors[*].endpoints[*]
    then:
      field: id
      function: casing
      functionOptions: { type: kebab }
overrides:
  - files: ["legado/**"]        # globs relativos à pasta do projeto
    rules:
      endpoint-description: off
```

Uma regra tem `given` (um JSONPath, ou uma lista), `then` (uma função, ou uma lista, com `field`
opcional) e `severity` (`warn` se faltar). `message` aceita `{{error}}` (a mensagem da função),
`{{description}}`, `{{path}}`, `{{property}}` e `{{value}}`. `hint` é do VVPost: diz como corrigir,
e o agente recebe junto com o achado. `recommended: false` deixa a regra desligada até alguém
estender com `all`. `aliases` funciona como no Spectral (`given: "#Endpoint.path"`).

### O documento que as regras leem

O `given` é um JSONPath sobre o projeto, como está nos arquivos (sem a herança resolvida):

| Caminho | O que é |
| --- | --- |
| `$.connectors[*]` | Conector: `id`, `name`, `description`, `extends`, `config`, `endpoints` |
| `$.connectors[*].endpoints[*]` | Endpoint: `id`, `name`, `method`, `path`, `headers`, `query`, `bodySchema`, `body`, `plugin`, `scenarios`, `examples` |
| `$.connectors[*].endpoints[*].scenarios[*]` | Cenário: `id`, `name`, `overrides`, `assertions`, `dependsOn`, `capture` |
| `$.connectors[*].endpoints[*].examples[*]` | Resposta de exemplo: `name`, `status`, `headers`, `body`, `schema` |
| `$.environments[*]` | Ambiente: `id`, `name`, `variables` (`{ NOME: { type, value, isSecret } }`) |
| `$.flows[*]` | Fluxo comum (os fluxos-base e de requisição já são conectores e endpoints): `id`, `name`, `description`, `nodes`, `edges` |
| `$.docs[*]` | Página `.md` de `docs/` (sem `docs/export`): `file`, `title`, `headings`, `text`, `directives`, `references.connectors`, `references.endpoints` |
| `$.diagrams[*]` | Diagrama de arquitetura de `docs/` (C4, ou fluxograma e `architecture-beta` com `%% vvpost:`) (bloco ` ```mermaid ` ou `.mmd`): `file`, `line`, `type`, `title`, `elements` (`alias`, `macro`, `kind`, `external`, `label`, `technology`, `description`, `parent`, `line`), `relations` (`from`, `to`, `label`, `technology`, `line`), `bindings`, `covers`, `ignores` |
| `$.auth[*]` | Auth de cada conector com a herança: `connector`, `auth` (o tipo, ou `null`), `from`, `authHeader`, e por endpoint (`id`) os `credentialHeaders` que ele manda por conta própria, com os dos cenários (`scenarios[].credentialHeaders`); a regra `connector-auth-consistent` lê daqui com a função `authConsistency` |
| `$.drift[*]` | Divergência entre a documentação e o catálogo: `code`, `message`, `hint`, `file`, `line` (as regras `c4-*`, `doc-unknown-reference`, `doc-code-map` e `doc-stale-since-change` leem daqui com a função `drift`) |
| `$.tokens[*]` | Token da [marca](brand.md): `name`, `type`, `value` (resolvido, em texto: `#bd948a`, `8px`), `modes`, `description`, `file`, `line` |
| `$.brand[*]` | Achado da marca: `code`, `message`, `hint`, `file`, `line`, `label`, `token` (as regras `tokens-*` e `brand-*` leem daqui com a função `drift`) |

Os conectores compartilhados e os do Compartilhado de um projeto ficam de fora: eles são lidos, não
editados, ali.

O JSONPath segue o dialeto do Spectral: `$`, `.nome`, `['nome']`, `[0]`, `[-1]`, `[0:2]`,
`[get,post]`, `*`, `..` e filtros `[?(...)]` com `@`, `@property`, `@path`, `==`, `===`, `!=`,
`!==`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, `.length` e os métodos `match`, `test`, `includes`,
`startsWith`, `endsWith`, `toLowerCase`, `toUpperCase` e `trim`. O filtro é interpretado, nunca
executado como JavaScript: um ruleset é dado, não código.

### Funções

As nativas do Spectral, com as mesmas opções: `truthy`, `falsy`, `defined`, `undefined`, `pattern`
(`match`, `notMatch`, com `/regex/flags` ou só o texto), `casing` (`flat`, `camel`, `pascal`,
`kebab`, `cobol`, `snake`, `macro`, com `disallowDigits` e `separator`), `enumeration` (`values`),
`length` (`min`, `max`), `schema` (`schema`, `allErrors`), `alphabetical` (`keyedBy`), `xor` e `or`
(`properties`). Do VVPost: `drift` (reporta um item de `$.drift[*]` com a mensagem e o hint dele), `authConsistency` (sobre `$.auth[*]`), e `oasPathParam` e `oasOpParams` para a spec OpenAPI. `field: "@key"` aplica a função ao nome de cada chave. Como no Spectral, o campo que
não existe chega como `undefined`: `truthy` e `defined` acusam, as outras ignoram.

## Rulesets do Spectral e OpenAPI

O formato é o do Spectral, então boa parte de um `.spectral.yaml` roda sem mudança. As regras de
OpenAPI rodam na spec que o `vvpost export --format openapi` gravaria, e cada achado volta ao
arquivo do endpoint (ou do conector, para tags e `info`) de onde a operação saiu.

- `extends: spectral:oas` traz um recorte das regras recomendadas do Spectral, com os mesmos nomes:
  `info-contact`, `info-description`, `oas3-api-servers`, `tag-description`,
  `operation-description`, `operation-operationId`, `operation-success-response`,
  `path-keys-no-trailing-slash`, `path-params`, `operation-parameters`, `no-script-tags-in-markdown`,
  `no-eval-in-markdown` e `duplicated-entry-in-enum` (`operation-tags` e `openapi-tags` desligadas).
  `path-params` (erro) acusa a variável `{nome}` sem parâmetro `in: path` com `required: true`, o
  parâmetro de caminho que não aparece no caminho, a variável repetida e dois caminhos que só diferem
  no nome das variáveis (`/pedidos/{id}` num endpoint e `/pedidos/{pedidoId}` em outro);
  `operation-parameters` acusa o parâmetro que repete `in` e nome na mesma operação.
- Uma regra vale para a spec OpenAPI quando tem `formats: [oas3]` (ou `oas3.0`, `oas3.1`), quando o
  `given` começa em `$.paths`, `$.info`, `$.components`, `$.servers` ou `$.tags`, ou quando não tem
  `formats` num ruleset que estende o `spectral:oas`. `formats: [vvpost]` deixa explícito que é do
  projeto.

O que não roda vira aviso do ruleset, sem derrubar o resto: `functions` e `functionsDir` (funções
em JavaScript), `extends` por URL (o lint não acessa a rede: copie o ruleset para o repositório),
outros rulesets embutidos (`spectral:asyncapi`, `spectral:arazzo`) e `extends` dentro de
`overrides`.

## No CI

```bash
vvpost lint --sarif lint.sarif --junit lint.xml
```

Sai com 2 quando há achado de nível `error` (`--fail-on warn` reprova também nos avisos) ou quando
o ruleset é inválido. O SARIF leva os caminhos relativos à pasta de onde o CLI roda, que no CI é a
raiz do repositório, e o GitHub marca as linhas no pull request com o
`github/codeql-action/upload-sarif`. O JUnit tem um caso por achado do nível do `--fail-on` para
cima. `vvpost validate --lint` junta as duas conferências num passo: os erros do lint reprovam e os
avisos aparecem.
