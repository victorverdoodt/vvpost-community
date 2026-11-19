# @vvpost/schemas

JSON Schemas v1 dos arquivos do workspace VVPost, tipos TypeScript
gerados a partir deles e validadores prontos para usar no main process.

| Schema | Arquivo do workspace | Tipo |
| --- | --- | --- |
| [`connector.json`](schemas/connector.json) | `*.connector.vvpost.json` | `Connector` |
| [`environment.json`](schemas/environment.json) | `environments/*.env.json` | `Environment` |
| [`secrets-engine.json`](schemas/secrets-engine.json) | `.vvpost/secrets-engine.json` | `SecretsEngineConfig` |
| [`flow.json`](schemas/flow.json) | `*.flow.vvpost.json` | `Flow` |
| [`plugin.json`](schemas/plugin.json) | `vvpost-plugin.json` (manifesto de plugin, [docs/plugins.md](../../docs/plugins.md)) | `PluginManifest` |
| [`bundle.json`](schemas/bundle.json) | `*.vvpost.bundle.json` (pacote de importação e exportação, [docs/import-export.md](../../docs/import-export.md)) | `Bundle` |
| [`project.json`](schemas/project.json) | `vvpost.project.json` (uma subpasta do workspace que é um projeto, [docs/git-workspace.md](../../docs/git-workspace.md#projetos)) | `Project` |

Os schemas usam JSON Schema 2020-12 e o `$id` de cada um é a URL que os arquivos
colocam em `"$schema"` (ex.: `https://vvpost.dev/schemas/v1/connector.json`).

```ts
import { validateConnector, type Connector } from '@vvpost/schemas'

const result = validateConnector(JSON.parse(text))
if (!result.ok) console.error(result.issues) // [{ path: '/endpoints/0/method', message: '...' }]
```

## Versões

A versão major de cada schema está na URL (`/v1/`) e o arquivo declara a dele no `"$schema"`.
Todo `validate*` confere a versão antes da forma (`checkSchemaVersion`): sem `"$schema"` vale a
versão atual; uma versão mais nova que a do pacote é recusada com "atualize o app"; uma mais
antiga passa pelas migrações de `MIGRATIONS` e o resultado já vem na versão atual; uma URL de
outro tipo é recusada. Caminho local terminado em `/<tipo>.json` (cópia do schema para o editor)
é aceito. Campo opcional novo não muda a versão; remover, renomear, mudar significado ou
restringir uma regra cria a `v2`, com a migração da `v1`.

```ts
import { CURRENT_SCHEMA_VERSION, checkSchemaVersion, schemaUrl } from '@vvpost/schemas'

schemaUrl('connector') // https://vvpost.dev/schemas/v1/connector.json
checkSchemaVersion(doc, 'environment') // { ok, version, doc, migrated } ou { ok: false, issues }
```

## Regras além da forma

- **Ambiente:** variável com `isSecret: true` só pode ter o valor `__REQUIRED_SECRET__`
  (o valor real fica no cofre local cifrado, fora do projeto). Um segredo de verdade num arquivo
  commitado reprova a validação, e o template numa variável não secreta também.
  O `value` precisa bater com o `type` declarado.
- **Conector:** ids de endpoint únicos no conector, ids de cenário únicos no endpoint,
  nenhum header repetido com maiúsculas diferentes no mesmo objeto, e um conector não pode
  herdar de si mesmo. Ciclos entre conectores diferentes e pai
  ausente dependem do catálogo inteiro: o resolvedor de herança do app
  (`packages/core/src/connectors/resolve.ts`) aponta o erro no conector e o Catálogo o mostra, junto
  com os conflitos de herança ([precedência](../../docs/architecture.md#precedência-e-conflitos-na-herança)) (header da cadeia com o nome do header da auth,
  mais de 16 níveis).
  Asserções: `exists`/`notExists` não levam `expected`, comparações exigem número,
  `matchesSchema` exige um schema, e `status`/`responseTimeMs` não aceitam operadores de texto.
- **Auth do conector:** um tipo por `type`, e o erro aponta só para o tipo escolhido.
  OAuth2 `password` exige `username` e `password`; o login aceita um corpo só (`json`, `form`
  ou `body`); mTLS exige `cert` e `key` juntos, ou `pfx` sozinho.
- **Secret engine:** o modo escolhido exige a seção correspondente, `storageFile` é
  um `.json` relativo ao workspace (sem `..` nem caminho absoluto), a URL do cofre é
  HTTPS e `enforceMemoryOnly` só aceita `true` (Zero-Disk Footprint).
- **Manifesto de plugin:** `main` relativo e dentro da pasta do plugin (sem `..` nem caminho
  absoluto), pelo menos uma contribuição, tipos de nó e protocolos únicos no plugin, chaves de
  campo únicas, `select` com `options` e o `default` entre elas. Tipos de nó têm namespace
  (`acme.greet`) e `http`/`https` não são protocolos de adapter.
- **Fluxo com herança:** um fluxo não herda de si mesmo, os headers de `defaults` não se
  repetem com maiúsculas diferentes, os ids de cenário são únicos e `"basePath": false` só vale
  no nó de login (com `cache`). `defaults.auth`, `defaults.tls`, `scenarios` e `examples` usam as
  mesmas definições do conector (o `$ref` aponta para o `$id` de `connector.json`). Se a base
  existe e o login tem a forma esperada, só o workspace inteiro diz: `compileFlows`
  (`packages/core/src/flows/inherit.ts`) aponta o problema no arquivo ([docs/flows.md](../../docs/flows.md#herança-entre-fluxos)).
- **Nó de plugin no fluxo:** `plugin.node` ou `plugin.adapter`; `connector` e `ignoreHttpErrors`
  só com `adapter`. Se a contribuição existe e a config bate com os campos dela, só o app sabe
  (depende dos plugins instalados): o nó falha com `PLUGIN_UNAVAILABLE` ou `CONFIG_ERROR`.

## Autenticação e mTLS

`config.auth` e `config.tls` são herdados pela cadeia de `extends` inteiros: o filho que
define `auth` substitui a do pai (`{ "type": "none" }` desliga), sem mesclar campo a campo.
Todos os textos aceitam `{{VAR}}` do ambiente ativo, e segredos devem vir de variáveis com
`isSecret: true`. O Quick Request executa a auth no main process.

```jsonc
"auth": { "type": "bearer", "token": "{{ACCESS_TOKEN}}" }              // header/prefix opcionais
"auth": { "type": "apiKey", "name": "X-Api-Key", "value": "{{API_KEY}}", "in": "header" }
"auth": { "type": "basic", "username": "{{USER}}", "password": "{{PASSWORD}}" }
"auth": {
  "type": "oauth2",
  "grantType": "client_credentials",          // ou "password", com username/password
  "tokenUrl": "/oauth/token",                 // absoluta ou relativa à baseUrl
  "clientId": "{{CLIENT_ID}}",
  "clientSecret": "{{CLIENT_SECRET}}",
  "scope": "billing.read",
  "clientAuthentication": "basic"             // ou "body"
}
"auth": {
  "type": "login",
  "request": { "url": "/auth/login", "json": { "user": "{{USER}}", "password": "{{PASSWORD}}", "otp": "{{$totp:MFA_SEED}}" } },
  "token": "body.data.accessToken",           // ou headers.<nome>
  "expiresIn": "body.data.expiresIn",         // ou ttlSeconds fixo
  "inject": { "in": "header", "name": "Authorization", "value": "Bearer {{$token}}" }
}
"auth": {
  "type": "oauth2",
  "grantType": "authorization_code",          // login no navegador do sistema
  "authUrl": "https://login.exemplo.com/authorize",
  "tokenUrl": "https://login.exemplo.com/token",
  "clientId": "{{CLIENT_ID}}",
  "redirectUri": "http://127.0.0.1:8765/callback", // opcional; padrão: porta livre em /callback
  "pkce": true                                // padrão
}
"auth": { "type": "digest", "username": "{{USER}}", "password": "{{PASSWORD}}" }
"auth": { "type": "ntlm", "username": "{{USER}}", "password": "{{PASSWORD}}", "domain": "CORP" }
"auth": {
  "type": "awsSigV4",
  "accessKeyId": "{{AWS_ACCESS_KEY_ID}}",
  "secretAccessKey": "{{AWS_SECRET_ACCESS_KEY}}",
  "sessionToken": "{{AWS_SESSION_TOKEN}}",    // opcional
  "region": "sa-east-1",
  "service": "execute-api"                    // s3, lambda...
}
"auth": {
  "type": "oauth1",
  "consumerKey": "{{CONSUMER_KEY}}",
  "consumerSecret": "{{CONSUMER_SECRET}}",
  "token": "{{TOKEN}}",
  "tokenSecret": "{{TOKEN_SECRET}}",
  "signatureMethod": "HMAC-SHA1"              // ou HMAC-SHA256, PLAINTEXT
}
"tls": { "cert": "certs/client.crt", "key": "{{CLIENT_KEY_PATH}}", "ca": "certs/ca.pem" }
```

Caminhos de `tls` são relativos à pasta do workspace (ou absolutos). Chaves privadas não
devem ser commitadas: aponte `key` para uma variável com o caminho local.

## Scripts pre e post

`config.scripts` (no conector, herdado pela cadeia) e `scripts` (no endpoint) têm `pre` e `post`,
JavaScript com a API `vv` ([docs/quick-request.md](../../docs/quick-request.md#scripts-pre-e-post)):

```jsonc
"scripts": {
  "pre": "vv.request.headers['X-Tenant'] = vv.variables.get('TENANT')",
  "post": "vv.test('status 200', () => vv.expect(vv.response.status).to.equal(200))"
}
```

No fluxo, o nó de requisição aceita `"scripts": false` (não roda os do conector e do endpoint) e
`"fromScript": "<nó>"` (a requisição sai como um nó `javascript.request-script` a deixou), e
`"requestScripts": { "pre", "post" }`, os scripts do próprio nó, que rodam depois dos do conector e do
endpoint, como os de uma requisição do Quick Request salva como fluxo.

## Desenvolvimento

Requer Node 22.18+ (os testes rodam TypeScript direto, sem build).

```bash
npm install
npm run generate   # regenera src/types/*.ts a partir de schemas/*.json
npm run verify     # tipos gerados em dia + typecheck + testes
```

Os arquivos em `src/types/` são gerados: altere o schema e rode `npm run generate`.
`npm run verify` falha se alguém esquecer.

Os schemas são compilados sob demanda, na primeira validação de cada tipo, para
não pesar no startup do app.
