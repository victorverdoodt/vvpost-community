# CLI para CI/CD (`vvpost`)

O `vvpost` roda os cenários de teste e os fluxos do workspace sem abrir o
app, para pipelines de CI/CD. Ele não é uma reimplementação: usa o mesmo motor do app (dispatcher
Undici, auth headless com herança, Context Engine, plugins e Secret Sanitizer), que fica em
`packages/core` (pacote `@vvpost/core`) e roda em Node puro. O que passa no app passa no CI, e vice-versa.

## Instalação e execução

Três jeitos de ter o `vvpost`, todos com o mesmo motor:

| Jeito | Comando | Requisito |
| --- | --- | --- |
| Pacote npm | `npx vvpost run ...` (ou `npm i -g vvpost`) | Node 22.19 ou mais novo |
| Com o app instalado | `vvpost run ...` (no `.deb` fica em `/usr/bin/vvpost`; nos outros sistemas, veja [packaging.md](packaging.md#o-comando-vvpost-no-instalador)) | Nada além do app: roda no Electron dele com `ELECTRON_RUN_AS_NODE=1` |
| Do código-fonte | `npm ci && npm run build && node out/main/cli.js run ...` | Node 22.19 ou mais novo |

O pacote npm traz também o servidor MCP como `vvpost-mcp` (as mesmas opções de `node out/main/mcp.js`).
Como ele é gerado e publicado está em [packaging.md](packaging.md#pacote-npm-do-cli-npx-vvpost).

## Comandos

| Comando | O que faz |
| --- | --- |
| `vvpost run` | Roda cenários e fluxos e escreve o relatório. Sem filtros, roda os cenários de todo conector que tem cenários e todo fluxo do workspace (os fluxos-base e de requisição contam como os conectores e endpoints que são, sem rodar duas vezes). |
| `vvpost projects` | Lista os [projetos do workspace](git-workspace.md#projetos) e marca o atual. `--json -` devolve em JSON. |
| `vvpost list` | Lista conectores (com os cenários de cada um, já com a herança, e o arquivo, que num fluxo-base é o da base), ambientes e fluxos. `--json -` devolve em JSON. |
| `vvpost migrate` | Converte conectores `.connector.vvpost.json` (com os endpoints dentro) para [fluxos](flows.md#converter-conectores-em-fluxos): uma base por conector e um fluxo de requisição por endpoint, um por arquivo, com a doc movida para o lado da base. O schema copiado em vários endpoints (import antigo do OpenAPI) vira [schema compartilhado](catalog.md#schemas-compartilhados) em `schemas/`. `--dry-run` só mostra o que mudaria, `--connector <id>` (repetível) limita a conversão e `--json -` devolve o plano em JSON. Conectores compartilhados e os que não cabem no formato de fluxo ficam como estão, com o motivo. Sai com 2 se a conversão for recusada (nada é gravado). |
| `vvpost doctor` | A [prontidão](readiness.md) do workspace: por ambiente e de uma vez, o segredo sem valor, a variável que o ambiente não define, a URL inválida e a API que não abre conexão (só TCP, nada é enviado), com os segredos do CI aplicados. `--env` limita, `--no-probe` não abre conexão e `--json -` devolve em JSON. Sai com 2 se houver bloqueio. |
| `vvpost validate` | Confere JSON, schemas e a herança de todos os arquivos do workspace, e se a documentação acompanha as definições: diretiva do documento do projeto ou seção `{#id}` do `.md` de um conector apontando para o que não existe, corpo padrão fora do `bodySchema`, [exemplo de resposta](mock.md#exemplo-conferido-pelo-schema) fora do `schema` dele e os [plugins declarados](plugins.md#plugins-declarados-no-workspace) em `vvpost.plugins.json`. Sai com 2 se algum tiver problema. Corpo de cenário fora do schema é aviso (teste negativo manda corpo inválido de propósito); com `--strict`, conta como problema. |
| `vvpost lint` | Confere as [regras de estilo e os erros comuns](lint.md) do projeto: as do ruleset do time em `.vvpost/ruleset.yaml` (formato do Spectral, regras por JSONPath) ou as do `vvpost:recommended`, e as de OpenAPI na spec exportada quando o ruleset pede. Saída em texto, JSON, JUnit e SARIF ([abaixo](#vvpost-lint)). Sai com 2 em achado de nível `error` ou com ruleset inválido. Complementa o `validate`: `vvpost validate --lint` roda os dois, e os erros do lint também reprovam. |
| `vvpost export` | Grava o pacote do VVPost (`.vvpost.bundle.json`) do workspace ou de uma seleção, ou, com `--format`, uma coleção do Postman (com os ambientes do Postman ao lado) ou uma spec OpenAPI 3.1 ([formatos](import-export.md#exportar-para-o-postman-e-openapi)), ou, com `--format zip`, a pasta do projeto ou do workspace inteiro num `.vvpost.zip` ([abaixo](#zip-do-workspace-ou-do-projeto)), sem nenhum valor de segredo. Sai com 1 se a exportação for recusada por segredo. |
| `vvpost import <arquivo \| pasta \| URL>...` | Importa pacotes do VVPost, coleções/ambientes do Postman, specs OpenAPI 3.x/Swagger 2.0 (JSON ou YAML, arquivo ou URL), exportações do Insomnia, coleções do Bruno (pasta, `.bru` ou JSON), HAR e WSDL ([formatos](import-export.md#importar-do-insomnia-do-bruno-de-har-e-de-wsdl)) no workspace, e abre um `.zip` do VVPost como workspace ou projeto ([abaixo](#zip-do-workspace-ou-do-projeto)), pela mesma camada de escrita do app. Com `--reimport <conector>`, relê a spec de onde o conector veio e mescla o que mudou ([Reimportar a spec](import-export.md#reimportar-a-spec)). Sai com 2 se algum arquivo tiver problema (nada é gravado). |
| `vvpost sync` | Sincroniza o projeto com a spec OpenAPI gerada pelo código, com `--check` para o CI ([abaixo](#vvpost-sync)). |
| `vvpost webhooks` | Liga o [servidor local de webhooks](webhooks.md) até o `Ctrl+C`: escreve uma linha por evento e por disparo e roda os disparos dos hooks. Opções: `--port`, `--env` (ambiente das assinaturas e dos disparos), `--secrets` e `--var` como no `run`, e `--json -` (NDJSON, sem headers nem corpo). |
| `vvpost mock` | Liga o [mock server](mock.md) até o `Ctrl+C`: cada endpoint responde com os exemplos de resposta salvos nele, em `basePath` + `path`. Opções: `--port` (padrão `$VVPOST_MOCK_PORT` ou `4490`), `--connector` (repetível) e `--json -` (NDJSON). Escreve as rotas no stderr e uma linha por requisição no stdout. |
| `vvpost guard` | O leak guard do commit pelo app para commits feitos fora dele: confere o que está no index do Git (o próximo commit) contra os vaults de todos os projetos do workspace, em qualquer codificação, e recusa credencial literal num conector ou fluxo, chave privada PEM e o `.vvpost/secrets.local.json` do formato antigo. Sai com 1 se achar, citando arquivo e variável, nunca o valor. `--all` confere todos os arquivos versionados (para o CI ou a primeira vez), `--json -` devolve em JSON e `--install` instala o hook de pre-commit no repositório (o mesmo do menu do Git no app), que usa o `vvpost` do PATH ou, sem ele, o CLI de quem instalou. Um pre-commit que não é do VVPost não é sobrescrito: a mensagem mostra a linha a acrescentar. |
| `vvpost plugin <subcomando>` | Para quem publica plugins: `keygen --out <arquivo.key>` cria a chave Ed25519, `sign <pasta> --key <arquivo.key>` grava `vvpost-plugin.sig.json`, `pack <pasta> [--key] [--out]` gera o `.zip` (assinando antes) e mostra o SHA-256 e a entrada do registro, e `verify <pasta\|pacote>` confere a assinatura (0 válida, 1 sem assinatura ou inválida). Não precisa de workspace. Veja [Publicar um plugin](plugins.md#publicar-um-plugin). |
| `vvpost schema <conector>/<endpoint>` | Mostra e edita os campos do corpo do endpoint (o `bodySchema` do formulário tipado) sem escrever JSON Schema ([abaixo](#vvpost-schema)). |
| `vvpost docs` | Gera a documentação rica em Markdown, com diagramas Mermaid, do projeto, de um conector, de um endpoint ou de uma request (a mesma do "Gerar documentação" do app). Com `vvpost.docs.json`, o projeto sai como o [documento do projeto](documentation.md), no padrão do modelo. Nenhum valor de segredo entra. |
| `vvpost docs init` | Cria o modelo (`vvpost.docs.json`) e o documento-fonte (`docs/projeto.md`); `--template` (`api-guide`, `c4`, `arc42`, `diataxis`, `adr` ou um do projeto) e `--title`. |
| `vvpost docs templates` | Lista os modelos de documentação. |
| `vvpost docs export` | Grava a documentação como site HTML estático (ou no formato de um exportador de plugin, como o MkDocs) na pasta do destino do `vvpost.publish.json`, com a página Mudanças; `--target`, `--out`, `--label`, `--force`. Guia em [publish.md](publish.md#no-ci-vvpost-docs-export). |
| `vvpost connect [repositório]` | Liga um repositório de código ao VVPost num passo ([abaixo](#vvpost-connect)): registra o servidor MCP nos clientes de IA e grava a regra do VVPost no `CLAUDE.md`/`AGENTS.md` dele. |
| `vvpost secrets list \| set \| rm` | Os valores das variáveis secretas no [cofre local](security-model.md#cofre-local), sem o app ([abaixo](#vvpost-secrets)). |
| `vvpost login <url>` | VVPost Enterprise: registra a organização pelo endereço do Control Plane, confirma o host e confere o login ([abaixo](#vvpost-login)). |
| `vvpost docs agents` | Mostra o trecho de `CLAUDE.md`/`AGENTS.md` que manda a IA documentar no VVPost; com `--out <arquivo>`, acrescenta ao arquivo uma vez só. |

Todos os comandos aceitam `--workspace <pasta>` (padrão: `$VVPOST_WORKSPACE` ou a pasta atual) e
`--project <id>` (padrão: `$VVPOST_PROJECT`). Num workspace com [projetos](git-workspace.md#projetos),
uma pasta de dentro de um projeto vale o projeto, e `--project` escolhe outro.

### Opções de `run`

| Opção | Efeito |
| --- | --- |
| `--workspace <pasta>` | Workspace VVPost (padrão: `$VVPOST_WORKSPACE` ou a pasta atual). |
| `--env <ids>` | Ambientes, separados por vírgula ou repetindo a opção; `all` usa todos. Os cenários formam a matriz cenário × ambiente, como no app; cada fluxo roda uma vez por ambiente. Sem `--env`, roda sem ambiente. |
| `--connector <id>` | Só os cenários deste conector (repetível). |
| `--scenario <filtro>` | Só `<endpoint>` ou `<endpoint>/<cenário>` (repetível), em todo conector escolhido. |
| `--flow <id ou arquivo>` | Só este fluxo (repetível). Com `--connector` e sem `--flow`, nenhum fluxo roda, e vice-versa. |
| `--secrets <arquivo>` | Segredos num JSON `{ "<ambiente>": { "VAR": "valor" } }`, somados aos do [cofre local](security-model.md#cofre-local) da máquina. |
| `--catalog <arquivo>` | Conectores compartilhados, somente leitura (repetível). Aceita a resposta de `GET /api/v1/catalog?project=<id>` do Control Plane, uma lista de conectores ou um conector só. Veja [Catálogo centralizado no CI](#catálogo-centralizado-no-ci). |
| `--var NOME=valor` | Troca o valor de uma variável em todo ambiente que a declara, por exemplo a URL de um deploy de preview (repetível). |
| `--data <arquivo>` | CSV com cabeçalho ou JSON (lista de objetos): os cenários rodam uma vez por linha, com as colunas em `{{coluna}}` e `{{$data.coluna}}` e o número da linha em `{{$iteration}}`. Os fluxos rodam uma vez, como sem a opção. Veja [execução orientada a dados](tests.md#execução-orientada-a-dados). |
| `--junit <arquivo>` | Grava o relatório JUnit XML. |
| `--json <arquivo>` | Grava o relatório JSON; `-` escreve no stdout no lugar da saída de texto. |
| `--quiet` | Mostra só as falhas e o resumo. Cada cenário que falhou, e cada nó de fluxo com erro, mostra embaixo o método e a URL como foram montados (com os `pathParams` já codificados e os `{{VAR}}` ainda por resolver). |
| `--no-color` | Sem cores (também com `NO_COLOR`, ou quando a saída não é um terminal). |
| `--strict` | Arquivo inválido no workspace também conta como erro de configuração. Sem ele, o arquivo é ignorado com um aviso. |
| `--no-plugins` | Não carrega plugins: nós de plugin falham com `PLUGIN_UNAVAILABLE`. |
| `--history <nível>` | Grava a execução no histórico do app, com as requisições de cada cenário e fluxo: `metadata`, `headers` ou `full`. Sem a opção, nada é gravado. Uma falha ao gravar só avisa no stderr. |
| `--history-db <arquivo>` | Banco do histórico (padrão: `$VVPOST_HISTORY_DB` ou o `vvpost.db` da pasta `userData` do app). Sozinho, grava no nível `headers`. |
| `--port <n>` | Porta do servidor de webhooks, que o `run` liga só quando um fluxo tem nó webhook (padrão: a de `.vvpost/webhooks.json`, `$VVPOST_WEBHOOK_PORT` ou `4480`). A URL sai no stderr. |
| `--proxy <url ou off>` | Proxy de todas as requisições (HTTP, HTTPS ou SOCKS5, com usuário e senha na URL se precisar). Sem a opção, vale o que `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` e `NO_PROXY` dizem, como no curl; `off` desliga. Loopback nunca passa pelo proxy. |
| `--insecure` | Não verifica o certificado TLS dos servidores (autoassinado, expirado, de outro host). |
| `--ca <arquivo>` | CA extra em PEM, somada às do sistema (repetível). |
| `--cookie-jar <arquivo>` | Lê os cookies do arquivo e grava os da execução nele no fim (JSON, permissão 600). Sem a opção, o cookie jar vale só durante a execução: um login que devolve `Set-Cookie` serve aos cenários e fluxos seguintes. |

### Opções de `export`

| Opção | Efeito |
| --- | --- |
| `--format <formato>` | `vvpost` (padrão), `postman` (coleção v2.1 e um `<nome>.<ambiente>.postman_environment.json` por ambiente, ao lado), `openapi` (OpenAPI 3.1 em JSON, ou YAML se `--out` terminar em `.yaml`/`.yml`) ou `zip` (a pasta do projeto ou do workspace, [abaixo](#zip-do-workspace-ou-do-projeto)). Postman e OpenAPI levam conectores e endpoints; cenários e fluxos só vão no pacote. |
| `--connector <id>` | Só este conector, com todos os endpoints (repetível). |
| `--endpoint <conector/endpoint>` | Só este endpoint do conector (repetível). |
| `--env <ids>` | Só estes ambientes. Variáveis secretas vão como `__REQUIRED_SECRET__`. |
| `--flow <id>` | Só este fluxo; os conectores que ele usa entram junto (repetível). |
| `--no-scenarios`, `--no-docs` | Sem os cenários de teste, sem a documentação Markdown. |
| `--name <nome>` | Nome do pacote. |
| `--out <arquivo>` | Onde gravar (padrão `<pasta>.vvpost.bundle.json`, `.postman_collection.json` ou `.openapi.json` na pasta atual); `-` escreve no stdout só o arquivo principal. |

Sem filtros, exporta tudo. Os pais (`extends`) dos conectores escolhidos sempre entram junto.

### Opções de `import`

| Opção | Efeito |
| --- | --- |
| `--conflict <modo>` | Para ids que já existem: `merge` (padrão; acrescenta só endpoints, cenários e variáveis novos, e o fluxo do projeto fica), `rename` (importa ao lado com outro id) ou `replace`. |
| `--dry-run` | Só lista os arquivos que mudariam. |
| `--reimport <conector>` | Relê a spec OpenAPI de `source.location` do conector (ou do raiz dele) em vez de receber arquivos. |
| `--spec-wins` | Na reimportação, endpoint editado no projeto e alterado na spec fica com a versão da spec (o padrão mantém o do projeto). |
| `--prune` | Na reimportação, apaga os endpoints que saíram da spec (o padrão mantém). |
| `--json -` | Resultado em JSON no stdout (com `sync`: cada endpoint atualizado, em conflito ou fora da spec). |

Valores de segredo que vierem nos arquivos vão para o [cofre local](security-model.md#cofre-local), cifrado e fora da pasta.

```bash
vvpost export --workspace ./api --flow checkout --env dev --out checkout.vvpost.bundle.json
vvpost export --workspace ./api --format postman --env dev,prod --out loja.postman_collection.json
vvpost export --workspace ./api --format openapi --connector loja --out loja.openapi.yaml
vvpost import checkout.vvpost.bundle.json --workspace ./outro-projeto --dry-run
vvpost import https://api.exemplo.com/openapi.json --workspace ./api
vvpost import ./colecao-bruno captura.har servico.wsdl --workspace ./api
vvpost import --reimport loja-de-pets --prune --workspace ./api
```

### `vvpost lint`

| Opção | O que faz |
| --- | --- |
| `--ruleset <arquivo>` | Outro ruleset (YAML ou JSON) no lugar de `.vvpost/ruleset.yaml`. |
| `--fail-on <nível>` | Sai com 2 a partir deste nível: `error` (padrão), `warn`, `info` ou `hint`. |
| `--json <arquivo>` | Relatório JSON (`version`, `ruleset`, `summary`, `issues` e `findings` com `code`, `severity`, `file`, `line`, `label`, `message`, `hint`, `path` e `target`); `-` escreve no stdout no lugar do texto. |
| `--junit <arquivo>` | JUnit XML: uma suíte por arquivo e um caso com falha por achado do nível de `--fail-on` para cima. |
| `--sarif <arquivo>` | SARIF 2.1.0, com os caminhos relativos à pasta de onde o CLI roda, para o code scanning do GitHub; `-` escreve no stdout. |
| `--quiet` | O texto mostra só erros e avisos (os relatórios levam tudo). |
| `--fix` | Antes do lint, corrige os diagramas de arquitetura que divergem do catálogo ([correção automática](documentation.md#correção-automática)) e lista os arquivos em `corrigido: ...` no stderr. |

```bash
vvpost lint --workspace ./api
vvpost lint --fail-on warn --sarif lint.sarif --junit lint.xml
vvpost validate --lint --strict
```

### `vvpost sync`

A spec OpenAPI gerada pelo código como fonte do contrato ([guia](openapi-sync.md)): relê a spec de
cada conector vinculado e aplica o que mudou, com a spec ganhando nos campos de contrato e o
VVPost guardando cenários, exemplos, docs, fluxos, ambientes e a config do conector.

```bash
vvpost sync --link ./openapi.yaml --connector pagamentos   # vincula um conector que já existe
vvpost sync                                                  # aplica o que mudou na spec
vvpost sync --check                                          # CI: sai com 1 se o VVPost difere da spec
vvpost sync --check --fail-on breaking                       # CI: só quando algo quebra
```

| Opção | O que faz |
| --- | --- |
| `--check` | Não grava; sai com 1 no drift e com 2 se a spec não der para ler. |
| `--fail-on <drift\|breaking>` | Com `--check`: qualquer diferença (padrão) ou só quebra. |
| `--connector <id>` | Só a spec deste conector (repetível). |
| `--link <arquivo\|URL>` | Vincula `--connector` à spec e sincroniza. |
| `--prune` | Apaga os endpoints que saíram da spec. |
| `--keep-edits` | O que foi editado no VVPost fica (padrão: a spec ganha). |
| `--dry-run` | Mostra o que mudaria, sem gravar e sem falhar. |
| `--json -` | O relatório em JSON. |

### Zip do workspace ou do projeto

`vvpost export --format zip` grava a pasta como está num `.vvpost.zip`
([o que vai e o que fica de fora](import-export.md#workspace-ou-projeto-em-zip-vvpostzip)): dentro de um
projeto, ou com `--project`, o projeto; na raiz, o workspace inteiro com todos os projetos. Os filtros
(`--connector`, `--env`...) não valem aqui. `--out` escolhe o arquivo (padrão `<pasta>.vvpost.zip`) e
`--name` o nome no manifesto. Sai com 1 se o zip teria um valor de segredo.

`vvpost import <arquivo.zip>` decide pela pasta de `--workspace`:

| Pasta | O que acontece |
| --- | --- |
| Vazia, ou que ainda não existe | O zip abre ali como workspace (o de um projeto vira um workspace de um projeto só). |
| Um workspace | O zip de um projeto, ou de um workspace sem projetos, entra como projeto novo: `--as <id>` troca o id (o nome da pasta) e `--name` o nome. Um id que já existe é recusado. |

`--dry-run` só diz o que faria. Nada que já existe é sobrescrito, e os segredos chegam sem valor.

```bash
vvpost export --workspace ./api --format zip --out loja.vvpost.zip               # o workspace inteiro
vvpost export --workspace ./api --project estoque --format zip                   # só o projeto estoque
vvpost import loja.vvpost.zip --workspace ./loja-copia                           # workspace novo
vvpost import estoque.vvpost.zip --workspace ./outro --as estoque-legado          # projeto novo
```

### Opções de `docs`

| Opção | Efeito |
| --- | --- |
| `--connector <id>` | Documenta só este conector, com todos os endpoints. Sem filtro, o projeto inteiro. |
| `--endpoint <id>` | Só este endpoint do conector; `<conector>/<endpoint>` dispensa o `--connector`. |
| `--scenario <id>` | Só esta request (cenário) do endpoint; `<endpoint>/<cenário>` dispensa o `--endpoint`. |
| `--out <arquivo>` | Onde gravar (padrão `<pasta>.docs.md` na pasta atual); `-` escreve no stdout. |
| `--generated` | No projeto, a referência gerada mesmo havendo documento do projeto. |
| `--strict` | Sai com 1 se alguma diretiva do documento do projeto tiver erro (os diagnósticos vão para o stderr). |

O documento traz a herança efetiva com a origem de cada valor, a auth (campos de credencial só
como `{{VAR}}`), os schemas e exemplos, os cenários com overrides e asserções, a documentação
escrita (`*.connector.vvpost.md`), os fluxos que usam cada endpoint, as variáveis usadas com o
valor por ambiente (segredos só pelo nome) e os diagramas de herança, auth, sequência, fluxos e o
mapa do projeto. O texto passa pelo Secret Sanitizer e é recusado se ainda tiver o valor de uma
credencial do workspace.

```bash
vvpost docs --workspace ./api --out docs/api.md
vvpost docs --endpoint connector.billing.v2/charge_customer --out -
```

### `vvpost connect`

Rode na pasta do workspace (ou com `--workspace` e `--project`) e passe o repositório do código que
ele documenta. Em cada cliente, o servidor MCP fica registrado e a regra do VVPost entra no arquivo
de instruções que aquele cliente lê, já com o workspace e o projeto. Com a regra, um pedido só sobre
o código ("remova a rota X") também atualiza o catálogo, as páginas e o PDF.

| Cliente (`--client`) | Servidor MCP | Regra |
| --- | --- | --- |
| `claude` | `claude mcp add --scope local` (fica na sua máquina, fora do git) | `CLAUDE.md` |
| `cursor` | `.cursor/mcp.json` do repositório | `AGENTS.md` |
| `vscode` (Copilot) | `.vscode/mcp.json` do repositório | `AGENTS.md` |
| `codex` | `codex mcp add` | `AGENTS.md` |

Sem `--client`, vale o que o repositório e a máquina já usam (pastas `.cursor`, `.vscode`, os CLIs
`claude` e `codex`); sem nenhum, o Claude Code. O servidor sobe por stdio, ao lado do CLI, com
`--workspace`, `--project` e `--repo`; com `--http <url>` (ex.: `http://127.0.0.1:4470`), o cliente
usa o servidor do app, e com `$VVPOST_MCP_TOKEN` definido o arquivo do cliente lê o token do
ambiente, nunca o valor. Sem o CLI do cliente instalado, a linha diz o comando para rodar à mão e
o `connect` sai com 1. `--dry-run` só diz o que faria, e rodar de novo não duplica nada. O módulo
**MCP & IA** do app faz o mesmo pelo botão **Escolher repositório e ligar**.

```bash
vvpost connect ../estoque-api --project estoque
vvpost connect ../estoque-api --client claude,cursor --dry-run
```

### `vvpost schema`

Sem opções, lista os campos do corpo do endpoint (caminho, tipo ou valores aceitos, descrição;
`*` marca os obrigatórios). As mudanças passam pela mesma camada de escrita do app e do MCP
(`setBodyField` e `setBodySchema`): o conector é validado antes de gravar e, com erro, nada muda.

| Opção | Efeito |
| --- | --- |
| `--set <caminho>:<tipo>` | Cria ou troca um campo. Tipos: `string`, `integer`, `number`, `boolean`, `object`, `array`. Caminho: `valor`, `cliente.nome` ou `itens[].sku` (campo dos objetos da lista); os objetos do caminho são criados. |
| `--required`, `--description <texto>`, `--enum <a,b>`, `--format <formato>`, `--items <tipo>` | Junto com `--set`: obrigatório, descrição, valores aceitos, formato de string (`date`, `date-time`, `email`, `uuid`...) e o tipo dos itens de uma lista. |
| `--remove <caminho>` | Remove um campo (repetível). |
| `--from-body` | Gera o schema do corpo padrão do endpoint (tipos e formatos pelos valores, nenhum obrigatório). |
| `--file <schema.json>` | Troca o schema inteiro por um JSON Schema. |
| `--clear` | Tira o schema do endpoint. |
| `--dry-run` | Só mostra o que mudaria. |
| `--json -` | Escreve o JSON Schema resultante no stdout. |

```bash
vvpost schema loja/criar_pedido --from-body
vvpost schema loja/criar_pedido --set entrega:string --required --enum normal,expressa
vvpost schema loja/criar_pedido --set 'itens[].sku:string' --required --description "Código do produto"
vvpost schema loja/criar_pedido --remove observacao --json -
```

### `vvpost secrets`

Os valores das variáveis `isSecret` no cofre local da pasta (do projeto, com `--project` ou dentro
dele), o mesmo que o app e o `vvpost run` leem. Nenhum comando mostra um valor.

| Comando | Efeito |
| --- | --- |
| `vvpost secrets list` | Cada variável secreta por ambiente, `configurado` ou `pendente`. `--json -` em JSON. |
| `vvpost secrets set <ambiente> <VAR>` | Grava o valor. No terminal, pede o valor sem mostrar o que é digitado; num pipe, lê o stdin inteiro (sem a quebra de linha final). Só aceita variável declarada com `"isSecret": true` no ambiente. |
| `vvpost secrets rm <ambiente> <VAR>` | Apaga o valor do cofre. |

O valor nunca vai na linha de comando, que fica no histórico do shell e na lista de processos.

```bash
vvpost secrets set dev API_TOKEN                      # pede o valor
pass show api/dev | vvpost secrets set dev API_TOKEN  # de um gerenciador de senhas
vvpost secrets list
```

### `vvpost login`

VVPost Enterprise. Registra a organização na máquina pelo endereço do Control Plane, sem
`enterprise.json`: o módulo busca no Control Plane o IdP e o cliente de login (`GET
/api/v1/discovery`, público), confirma o host e abre o login no navegador para conferir. A
política, os cofres e o catálogo central vêm do Control Plane depois do login, a cada sessão.

```bash
vvpost login https://vvpost.contoso.com --project payments
```

`--project` é o projeto do Control Plane e `--env`, o ambiente do broker. O host confirmado aqui
também libera o login automático do MCP em workspaces que declaram essa organização
([organization.json](mcp.md#o-workspace-declara-a-organização)). Os tokens ficam só em memória:
cada processo (o app, o MCP) abre o próprio login.

### Códigos de saída

| Código | Quando |
| --- | --- |
| `0` | Todos os cenários passaram e todos os fluxos terminaram sem nó com erro. |
| `1` | Algum cenário falhou ou deu erro (inclusive segredo ausente, conexão recusada), ou algum fluxo terminou com nó com erro. |
| `2` | Uso ou configuração: opção inválida, workspace, ambiente, conector ou fluxo inexistente, nada para rodar, conector com herança quebrada, fluxo inválido ou, com `--strict`, arquivo inválido. |
| `130` | Interrompido (Ctrl+C ou SIGTERM). As requisições em voo são canceladas e o relatório parcial é escrito; o segundo Ctrl+C sai na hora. |

### Recursos desligados

`VVPOST_DISABLE_FEATURES` desliga recursos inteiros (ids separados por vírgula: `pythonNode`,
`scripts`, `plugins`, `protocols`, `mockServer`, `webhooks`, `secretEmulator`, `mcp`,
`piiVisible`), como no
[modelo de segurança](security-model.md#recursos-desligados). Com o módulo Enterprise, `run`,
`validate`, `list`, `mock` e `webhooks` aplicam também a lista da organização: a da conta aberta
ou, no CI, a última gravada pelo `vvpost login` nesta máquina. O que estiver desligado falha com
`POLICY_DENIED`.

## Segredos no CI

As variáveis `isSecret` ficam fora do Git. No CI, os valores entram só em memória,
sem nada gravado no workspace, por três caminhos, do mais fraco para o mais forte:

1. `VVPOST_SECRET_<VAR>`: vale para todo ambiente que declara `VAR`. É o jeito mais simples com
   os secrets do GitHub Actions ou do GitLab.
2. `--secrets <arquivo>`: um valor por ambiente, no formato do vault local.
3. `--var NOME=valor`: se a variável é `isSecret`, o valor também vai para os segredos, nunca para
   o ambiente em texto.

Segredo que nenhum caminho preencheu só falha quando alguém usa: o cenário termina com
`CONFIG_ERROR` e o CLI sai com 1.

## Catálogo centralizado no CI

Com o VVPost Enterprise, conectores corporativos ficam no catálogo do Control Plane e o
workspace só tem os conectores que herdam deles (`"extends": "corp.base"`). No app, o módulo
Enterprise sincroniza o catálogo sozinho; no CI, baixe o snapshot e passe com `--catalog`:

```bash
curl -fsS -H "Authorization: Bearer $VVPOST_CP_TOKEN" \
  "https://cp.contoso.com/api/v1/catalog?project=payments" > catalog.json
vvpost run --catalog catalog.json --env hml
```

As regras são as do app: o conector compartilhado é somente leitura, um arquivo do workspace
com o mesmo id é ignorado com um aviso (e conta como erro com `--strict`), e um conector do
catálogo com credencial escrita por extenso fica de fora. `list` mostra a origem
(`shared:cp.contoso.com/payments@org:3`), e `validate` confere a herança contra o catálogo.

O catálogo também publica fluxos ([flows.md](flows.md), Herança entre fluxos): uma base com o
login como nó (por exemplo, a auth corporativa que várias APIs usam) e fluxos de requisição que
herdam dela. A base entra como conector compartilhado, as requisições entram como endpoints dela,
e as bases e requisições do workspace herdam com `"extends": "<id>"`, como de um conector. O
login da base roda uma vez e o token vale para todas as APIs que herdam. As regras são as mesmas
dos conectores: só leitura, um id local igual é ignorado, e um fluxo com credencial escrita por
extenso fica de fora.

## Relatórios e o Secret Sanitizer

Toda saída do CLI (terminal, JUnit, JSON) passa pelo mesmo Secret Sanitizer do MCP ([modelo de segurança](security-model.md)), já
que logs e artefatos de CI costumam ser visíveis para mais gente que o workspace. Os segredos do
workspace e os do CI, os tokens obtidos pela auth headless, cookies de sessão e valores de headers
e campos de nome sensível saem como `[REDACTED_SECRET]`, também codificados em URL, form, JSON e
base64. O teste de superfície fica em `test/secret-leaks.test.ts` ([garantias](security-model.md#garantias-contra-vazamento-de-segredos)).

- **JUnit**: uma `testsuite` por conector (`scenarios.<conector>`) e uma por fluxo e ambiente
  (`flow.<id> [<ambiente>]`). Cada cenário é um `testcase` com `classname` `<conector>.<endpoint>`
  e nome `<cenário> [<ambiente>]`; asserção falha vira `<failure>` com esperado e recebido, e erro
  de requisição vira `<error>`. Nos fluxos, cada nó é um `testcase`: erro vira `<failure>`, nó
  pulado vira `<skipped>`, e os logs do nó vão em `<system-out>`.
- **JSON** (`version: 1`): `outcome` (`passed`, `failed`, `error` ou `canceled`), os totais, os
  ambientes, os relatórios de cenários e de fluxos no mesmo formato que o app mostra
  (`ScenarioRunReport` e `FlowRunReport` de `src/shared/ipc.ts`) e os arquivos ignorados.
- **Histórico** (`--history`): a execução aparece no módulo Histórico do app como origem CLI, com
  o mesmo mascaramento (modelo com `__REQUIRED_SECRET__`, o resto pelo sanitizer). Num runner de
  CI o banco vai em `--history-db`, por exemplo para guardar como artefato.

## Plugins

Nós de plugin usam os plugins oficiais que vêm com o build (`plugins/` na raiz do repositório e do
pacote npm, `resources/plugins` no app instalado) e os que o usuário instalou
pelo Extensions Hub, na mesma pasta `userData` do app (`~/.config/vvpost` no Linux,
`%APPDATA%\vvpost` no Windows, `~/Library/Application Support/vvpost` no macOS), respeitando os
que foram desligados. `VVPOST_USER_DATA` troca a pasta, útil no CI. Nada é carregado do workspace.
O `vvpost.plugins.json` da raiz do workspace declara quais plugins e versões o projeto pede. O
`run` e o `validate` param com o código 2 e o motivo quando falta um, quando a versão instalada é
outra ou quando um nó usa um plugin fora da lista
([Plugins declarados no workspace](plugins.md#plugins-declarados-no-workspace)).

## Exemplos

GitHub Actions, com o resultado na aba de testes por qualquer ação que leia JUnit:

```yaml
- uses: actions/checkout@v4
  with: { repository: victorverdoodt/vvpost-community, path: vvpost }
- run: cd vvpost && npm ci && npm run build
- name: Testes de API
  run: node vvpost/out/main/cli.js run --env staging --junit reports/vvpost.xml
  env:
    VVPOST_SECRET_API_TOKEN: ${{ secrets.STAGING_API_TOKEN }}
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: vvpost-junit, path: reports/vvpost.xml }
```

GitLab CI:

```yaml
api-tests:
  script:
    - node vvpost/out/main/cli.js run --env staging --var BASE_URL=$CI_ENVIRONMENT_URL --junit vvpost.xml
  artifacts:
    when: always
    reports: { junit: vvpost.xml }
```

## Execução remota

O CLI também é o motor da execução remota do VVPost Enterprise (módulo comercial,
[pontos de extensão](architecture.md#pontos-de-extensão-para-o-módulo-enterprise)): um agente na rede da
organização recebe o workspace sem segredos e roda `out/main/cli.js run --workspace <pasta
temporária> --json <relatório> --env ... --connector ... --scenario ... --flow ...`. Os códigos de
saída acima viram o resultado da execução (0 passou, 1 falhou, 2 erro, 130 cancelada), e os
segredos entram pelos mesmos caminhos desta página (`VVPOST_SECRET_<VAR>` ou `--secrets`). No app,
o botão **Rodar no runner** do módulo de testes, que só aparece com o módulo, envia o workspace
aberto, mostra a saída ao vivo e preenche a matriz com o relatório. Com um [projeto](git-workspace.md#projetos)
aberto, vai o projeto com o Compartilhado da raiz: os conectores e fluxos da raiz em
`compartilhado/` e os ambientes já mesclados (as variáveis do projeto vencem), então o runner vê o
mesmo workspace que o app, sem `--project`. Os outros projetos não vão, só as bases deles que o
projeto usa (`"extends": "estoque:cnpj"` ou o conector de um nó): cada uma vai em
`projetos/<projeto>/` como o app a lê, com a cadeia resolvida, sem os cenários do outro projeto e
com um id sem `:` (`estoque.cnpj`); as referências do pacote passam a esse id, e a prévia de envio
conta esses arquivos.
