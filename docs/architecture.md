# Arquitetura e contratos

Referência para quem contribui com o core, escreve plugins ou integra o VVPost: como o código se
divide, os pontos de extensão que o core oferece, o contrato de autenticação e as regras de
herança e de versionamento dos arquivos do workspace.

## Visão geral

O VVPost é um app Electron com três partes:

| Parte | Onde | O que faz |
| --- | --- | --- |
| Motor (`@vvpost/core`) | `packages/core` | Node puro, sem Electron: herança de conectores, auth headless, dispatcher HTTP (Undici), cenários, fluxos, Secret Sanitizer e políticas de disparo. O app, o CLI, o servidor MCP e os plugins usam o mesmo motor. |
| Main process | `src/main` | Workspace e Git, vault local, Secret Engine, servidor MCP, servidor de webhooks, plugins em processos isolados, histórico em SQLite e o IPC com a interface. |
| Interface | `src/renderer` | React, carregada sob demanda por módulo, sobre o design system em `src/renderer/src/design-system`. Fala com o main só pelo IPC tipado de `src/shared/ipc.ts`. |

Os formatos dos arquivos ficam em `packages/schemas` ([schemas JSON](../packages/schemas/README.md)).
A organização das pastas e os comandos estão em [development.md](development.md).

## Pontos de extensão para o módulo Enterprise

O VVPost é **local-first**: o core não exige backend nenhum, e o motor HTTP, o editor e o
formato `.vvpost` não dependem de servidor. Um módulo opcional (o VVPost Enterprise, comercial)
pode acrescentar recursos corporativos, sempre pelos contratos abaixo, que são a única
superfície que o core expõe para ele. Sem módulo, cada ponto é vazio e o app funciona inteiro.

| Ponto de extensão | Onde | O que o módulo fornece |
| --- | --- | --- |
| Carregamento do módulo | `src/main/secret-engine/backend.ts` (`EnterpriseSecretsModule`, `ENTERPRISE_API_VERSION`) | Pacote `@vvpost/enterprise` ou caminho em `VVPOST_ENTERPRISE_MODULE`; versão de API diferente é recusada |
| Backend de segredos | `SecretBackend` e `SecretAuditSink` (mesmo arquivo) | De onde o Secret Engine lê no modo `enterpriseProxy`, e a trilha de auditoria (fail-closed) |
| Identidade | `registerIdentityProvider` em `src/main/identity.ts`, contrato `IdentityState` em `src/shared/ipc.ts` | Login corporativo opcional, organização, papéis e política exibida na barra de contexto |
| Atividade | `controlPlane.activity` em `src/main/enterprise/control-plane.ts` | Recebe metadados do que acontece no desktop (nunca caminho, query, headers ou corpo), com melhor esforço |
| Catálogo compartilhado | `controlPlane.catalog` e `setSharedConnectors` (`packages/core/src/connectors/shared.ts`) | Conectores somente leitura que o workspace pode estender por `extends` |
| Execução remota | `controlPlane.runs` em `src/main/enterprise/remote-runs.ts` | Envia o workspace sem segredos para rodar fora da máquina e devolve o relatório do CLI |
| Recursos desligados | `controlPlane.features` em `src/main/enterprise/control-plane.ts`, aplicada por `src/main/enterprise/features.ts` e `packages/core/src/policy/features.ts` | A lista de recursos que a organização desligou no app, no CLI e no MCP; só desliga, nunca liga ([modelo de segurança](security-model.md#recursos-desligados)) |
| Política do agente | `controlPlane.agent` em `src/main/enterprise/control-plane.ts`, aplicada por `src/main/mcp/central.ts` | Política do MCP que só restringe as opções locais (fail-closed sem ela), um evento por chamada de ferramenta e a revisão de auth, destino e código aprovada fora do app ([mcp.md](mcp.md#política-central-módulo-enterprise)) |

**Regras de projeto:**
- O core só conhece os contratos; nenhuma regra de negócio do módulo entra aqui.
- Os dados que cruzam um ponto de extensão são copiados campo a campo e nunca carregam
  segredos, tokens ou valores do vault para o renderer, para logs ou para arquivos versionados.
- Requisições, fluxos e testes continuam executando localmente; nenhum ponto de extensão coloca
  um servidor no caminho das requisições.

## Contrato de autenticação

A autenticação dos conectores é um serviço do main process, não da tela. O mesmo motor
(`createAuthEngine` em `packages/core/src/connectors/auth.ts`, chamado por `sendHeadless`) atende o Quick
Request, os cenários de teste, os nós do Flow Studio, os plugins, o servidor MCP e a linha de
comando, e não importa nada do Electron nem do renderer (um teste confere o grafo de imports).

**Entrada:** o conector já resolvido (com a origem da auth na cadeia), o escopo de variáveis do
ambiente ativo, a `baseUrl` interpolada e a função de envio do dispatcher (com o mTLS do conector).
**Saída:** só headers e parâmetros de query prontos, mais um `usage` (`type`, `from`, `source`,
`ms`, `expiresAt`) que nunca carrega a credencial nem o token.

| Tipo | Onde entra | Roda fluxo | Renovável | Campos que só aceitam `{{VAR}}` |
| --- | --- | --- | --- | --- |
| `bearer` | header (`header`, padrão `Authorization`) | não | não | `token` |
| `apiKey` | header ou query (`in`) com o nome `name` | não | não | `value` |
| `basic` | `Authorization` | não | não | `password` |
| `oauth2` | `Authorization` com o `token_type` devolvido; pedido de token em form ou JSON (`tokenRequestFormat`) | token endpoint | sim (refresh_token, ou grant de novo) | `clientSecret`, `password` |
| `login` | `inject` (padrão `Authorization: Bearer {{$token}}`) | endpoint de login | sim | campos de nome sensível do corpo e dos headers |
| `digest` | `Authorization: Digest`, em resposta ao 401 do servidor (MD5, SHA-256, `-sess`, qop `auth`) | não | não | `password` |
| `ntlm` | `Authorization: NTLM` (NTLMv2), negotiate e authenticate na mesma conexão | não | não | `password` |
| `awsSigV4` | `Authorization: AWS4-HMAC-SHA256` mais `X-Amz-Date` (e `X-Amz-Security-Token`; no S3, `X-Amz-Content-Sha256`), assinando método, URL, headers e corpo | não | não | `secretAccessKey`, `sessionToken` |
| `oauth1` | `Authorization: OAuth` (HMAC-SHA1, HMAC-SHA256 ou PLAINTEXT), assinando a query e o corpo urlencoded | não | não | `consumerSecret`, `tokenSecret` |

Invariantes, válidos para todo tipo (presente e futuro) e conferidos por
`test/auth-contract.test.ts` para cada tipo do schema:
1. **Sem interação, com uma exceção:** a auth nunca abre janela nem pergunta nada; falha vira
   `AUTH_FAILED` com a mensagem do servidor. A exceção é o `oauth2` com `grantType:
   "authorization_code"`: o core abre um servidor de loopback só pelo tempo do login e pede a quem
   o chama (o app, o CLI num terminal) para abrir o `authUrl` no navegador, com PKCE S256. Sem esse
   hook, ou com um `RequestGuard` (MCP com política, hooks de webhook), o login nunca abre e só
   valem o token em cache e o `refresh_token`.
2. **Só em memória:** tokens obtidos ficam em RAM, por conector que define a auth + workspace +
   ambiente + valores das variáveis; mudar de ambiente nunca reaproveita token, e `clear()` descarta.
3. **Um fluxo por vez:** pedidos simultâneos com a mesma chave dividem o mesmo fluxo; cancelar uma
   requisição não cancela o fluxo que serve outras.
4. **Renovação:** o token vence 30 s antes do `expires_in`; um 401 com token vindo do cache descarta
   o token e repete a requisição uma única vez.
5. **Precedência:** um header digitado pelo chamador com o nome do header da auth substitui a auth
   inteira (o fluxo nem roda); `overrides.headers: null` ou retirar esse header desliga a auth.
6. **Fora da política:** o fluxo de auth foi escrito no workspace e não passa pela política de
   disparo dos [limites de disparo](security-model.md#limites-de-disparo); só a requisição do chamador passa.

Um `tokenUrl` (ou `request.url` do login) relativo entra depois da `baseUrl` inteira, com o
caminho dela e sem o `basePath`: com `baseUrl` `https://h/api/v1`, `/oauth/token` vira
`https://h/api/v1/oauth/token`. Para a raiz do host, use a URL absoluta. O plano do
`execute_dry_run` mostra a URL resolvida e avisa quando a `baseUrl` tem caminho.

Um tipo novo de auth entra em três lugares: o schema (`connector.json`), a tabela
`AUTH_CONTRACT` (`packages/core/src/connectors/auth-contract.ts`) e o motor. O teste de contrato falha se o
schema e a tabela divergirem.

## Precedência e conflitos na herança

A configuração efetiva de uma requisição é montada em camadas, da mais genérica para a mais
específica; a camada de cima vence (`resolveConnector` em `packages/core/src/connectors/resolve.ts`).
Um fluxo-base conta como conector e um fluxo de requisição, como endpoint
([Herança entre fluxos](flows.md#herança-entre-fluxos)):

1. Conector raiz da cadeia `extends`.
2. Cada descendente, até o conector usado.
3. Endpoint (`headers`, `query`, `path`).
4. Requisição: overrides do cenário, campos do Quick Request, do nó do fluxo ou da IA.
5. Auth do conector mais próximo que a define, aplicada por último.

| Campo | Regra |
| --- | --- |
| `baseUrl` | Substituída pela camada mais específica que define. |
| `basePath` | Concatenado da raiz ao filho, sem barras duplicadas; o `path` do endpoint vem depois. |
| `headers` | Mesclados pelo nome sem diferenciar maiúsculas; o de cima vence. `null` num override retira o header; `overrides.headers: null` retira todos os herdados e a auth. |
| `auth` | Herdada inteira, nunca campo a campo. O filho que define substitui; `{ "type": "none" }` desliga para ele e os descendentes, que podem definir outra. |
| `tls` | Herdado inteiro; o filho que define substitui. |
| `endpoints` | Não são herdados: cada conector expõe os próprios. |
| Ambiente | Só a camada 4 escolhe; variáveis são resolvidas no envio, depois da herança. |

Conflitos e o que acontece:

| Situação | Resultado |
| --- | --- |
| Ciclo de `extends`, pai ausente, mais de 16 níveis | Erro no conector (`CONFIG_ERROR` no envio, marcado no Catálogo); os outros conectores seguem usáveis. |
| Header de um conector da cadeia com o nome do header da auth efetiva | Erro: "conflito de herança". Tire o header ou desligue a auth. Auth na query não conflita. |
| Header repetido com maiúsculas diferentes no mesmo objeto | Erro de validação do arquivo. |
| Header da requisição (camada 4) com o nome do header da auth | Não é conflito: substitui a auth explicitamente ([contrato de autenticação](#contrato-de-autenticação)). |
| Filho troca a origem da `baseUrl` e herda a auth definida para outra origem | Aviso no Catálogo ("as credenciais vão para a nova origem"); a requisição segue. Não avisa quando a origem tem `{{VAR}}`. |
| Dois arquivos com o mesmo id de conector, ou de ambiente | Vale o primeiro em ordem de caminho; o outro vira issue e fica de fora. |
| Arquivo com schema mais novo ou de outro tipo | Recusado ([versionamento](#versionamento-dos-esquemas)). |

## Versionamento dos esquemas

Cada schema tem uma versão major, que está na URL do `$id`
(`https://vvpost.dev/schemas/v1/connector.json`). Os arquivos do workspace declaram a versão no
`"$schema"`, e `checkSchemaVersion` (`packages/schemas/src/versioning.ts`) roda antes de toda
validação:

| `"$schema"` do arquivo | Resultado |
| --- | --- |
| ausente | lido na versão atual |
| `https://vvpost.dev/schemas/vN/<tipo>.json` com N igual à do app | validado |
| N menor | migrado em memória pelas `MIGRATIONS` (N → N+1 → ... → atual) e validado; o arquivo só é regravado na versão atual quando o app salvar |
| N maior | recusado: "o arquivo usa o schema vN, mais novo que o deste VVPost; atualize o app" |
| URL de outro tipo (ex.: ambiente lido como conector) | recusado |
| caminho local terminado em `/<tipo>.json` | lido na versão atual (cópia do schema para o editor) |
| qualquer outro valor | recusado |

Política de evolução:
- **Mesma versão:** só campo novo opcional, com default que preserva o comportamento antigo.
  Como os schemas recusam campos desconhecidos, um app mais antigo que o workspace aponta
  "campo desconhecido": a regra é app igual ou mais novo que o workspace.
- **Versão nova (major):** remover ou renomear campo, mudar significado ou default, ou deixar
  uma regra mais restrita. Exige a migração da versão anterior em `MIGRATIONS` (um teste falha
  sem ela), o schema novo em `schemas/` e o `CURRENT_SCHEMA_VERSION` atualizado.
- O `version` de um conector (semver) é a versão da API que ele descreve, não do schema. Uma
  mudança incompatível de API ganha id novo (`connector.billing.v3`), e os filhos escolhem quando
  migrar pelo `extends`.
