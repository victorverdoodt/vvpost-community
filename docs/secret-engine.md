# Secret Engine: mock local de Secret Managers

O VVPost emula, numa porta local, as APIs do **Azure Key Vault**, do **AWS Secrets Manager** e
do **HashiCorp Vault**. A aplicação que você desenvolve continua usando o SDK
oficial do provedor; só o endereço do cofre muda para `http://localhost:4460`, e os valores vêm
do arquivo local de segredos do workspace, o mesmo que o Git Workspace usa.

## Ligar e desligar

O botão **Secrets** no canto direito da barra de status liga e desliga o mock. Ele serve o
workspace aberto no painel Git. Nada carrega até o primeiro clique: o servidor (Fastify) fica fora
da abertura do app e, ligado, acrescenta cerca de 17 MB ao main process. O servidor escuta só
em `127.0.0.1`.

## De onde vêm os segredos

- **Valores:** o [cofre local](security-model.md#cofre-local) da pasta, o mesmo do Git Workspace e do
  módulo Secrets, ou um arquivo JSON `{ "<id do ambiente>": { "<nome>": "<valor>" } }` em
  `localMock.storageFile` (em texto puro; precisa estar no `.gitignore`). Edições valem na hora.
- **Ambiente servido:** `localMock.activeEnvironment` em `.vvpost/secrets-engine.json`. Sem esse
  arquivo, vale o primeiro ambiente em `environments/` e a porta 4460.
- **Escritas:** os SDKs podem criar, alterar e apagar segredos; tudo vai para o mesmo arquivo,
  no ambiente servido.

## Ambientes, variáveis e segredos no app

O módulo **Secrets** edita os ambientes sem abrir os arquivos:

- **Novo ambiente**, **Renomear** e **Excluir ambiente** gravam e apagam
  `environments/<nome>.env.json` (o id vira `env.<nome>`). Excluir um ambiente não mexe nos valores
  dele no vault local.
- **Variáveis de <ambiente>** lista todas as variáveis com tipo e valor. O valor só aparece para
  quem não é segredo nem tem nome de credencial (`TOKEN`, `PASSWORD`, `API_KEY`...): esses ficam
  mascarados e nunca saem do processo principal. **Nova variável**, o lápis e a lixeira criam,
  editam (tipo, valor, `isSecret`, descrição) e excluem. Uma variável marcada como segredo grava
  `__REQUIRED_SECRET__` no arquivo versionado e o valor no vault local.
- **Substituir valor**, no inspector de um segredo configurado, troca o valor do vault local depois
  de uma confirmação com o ambiente e o impacto (o que usa `{{VAR}}` passa a usar o novo, e os
  tokens em cache são descartados). O valor antigo não aparece.
- Um arquivo de ambiente que não passa no schema (por exemplo, um segredo em texto puro) aparece
  com o motivo, e o app não o edita até o arquivo ser corrigido.

```json
{
  "$schema": "https://vvpost.dev/schemas/v1/secrets-engine.json",
  "port": 4460,
  "mode": "localMock",
  "localMock": { "activeEnvironment": "env.development" }
}
```

### Toggle Mock/Proxy

Quando `.vvpost/secrets-engine.json` tem o bloco `enterpriseProxy`, a barra de status mostra,
ao lado do botão **Secrets**, o seletor **Mock | Proxy**. Ele começa no `mode` do
arquivo. Trocar com o engine ligado reinicia na hora no outro modo, na mesma porta, e o rótulo
passa de `Secrets: Local Mock :4460` para `Secrets: Cloud Proxy :4460`. Com o engine
desligado, a troca só vale para o próximo clique em **Secrets**. A escolha fica em memória, por
workspace, até fechar o app: o arquivo versionado não muda, então ninguém altera o modo do time
por um clique. Sem o bloco, o seletor não aparece e `Proxy` não liga (o erro diz o que falta).
O Cloud Proxy precisa do módulo VVPost Enterprise; sem ele, o botão fica em erro com a
explicação e o seletor volta para Mock com um clique.

## Azure Key Vault

```ts
import { SecretClient } from '@azure/keyvault-secrets'
import { DefaultAzureCredential } from '@azure/identity'

const client = new SecretClient('http://localhost:4460', new DefaultAzureCredential(), {
  allowInsecureConnection: true,
  disableChallengeResourceVerification: true
})
const { value } = await client.getSecret('DATABASE-URL')
```

- O SDK do Azure recusa `http://` e confere se o desafio de autenticação é de um domínio pai do
  cofre. Num cofre em `localhost` não tem como passar nessas duas verificações, então o cliente
  precisa de `allowInsecureConnection` e `disableChallengeResourceVerification`. Vale para os SDKs
  de outras linguagens também (as opções têm o mesmo nome em cada um).
- **Login:** qualquer token serve. Para o `DefaultAzureCredential` funcionar sem conta, defina
  `IDENTITY_ENDPOINT=http://localhost:4460/msi/token` e `IDENTITY_HEADER=vvpost`: o engine responde
  como o endpoint de identidade gerenciada do App Service.
- **Nomes:** o Key Vault não aceita `_` e não diferencia maiúsculas. `database-url`, `DATABASE-URL`
  e `DATABASE_URL` acham a mesma variável.
- **Operações:** get (com ou sem versão), set, list, versões (sempre uma), update de propriedades,
  delete com soft delete, recover e purge. Itens apagados, tags e content type ficam só em memória
  enquanto o mock roda.

## AWS Secrets Manager

```ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

const client = new SecretsManagerClient({ endpoint: 'http://localhost:4460' })
const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: 'DATABASE_URL' }))
```

- Sem mudar código: `AWS_ENDPOINT_URL_SECRETS_MANAGER=http://localhost:4460` (ou
  `AWS_ENDPOINT_URL`). Os SDKs atuais de todas as linguagens leem essa variável.
- **Credenciais:** qualquer uma; a assinatura não é conferida. A região sai da assinatura.
- **Operações:** `GetSecretValue`, `BatchGetSecretValue`, `DescribeSecret`, `ListSecrets` (com filtro
  `name`), `CreateSecret`, `PutSecretValue`, `UpdateSecret` e `DeleteSecret`. `SecretId` aceita nome ou
  ARN. Só `SecretString`; `SecretBinary` volta como `InvalidParameterException`.

## HashiCorp Vault

```sh
export VAULT_ADDR=http://localhost:4460 VAULT_TOKEN=qualquer
vault kv get secret/DATABASE_URL
```

- **KV v2** em `/v1/<mount>/data/...` e `/v1/<mount>/metadata/...`; **KV v1** em `/v1/<mount>/...`.
  Todo mount mostra o mesmo ambiente.
- Cada variável é um caminho. Um valor em texto aparece como `{ "value": "..." }`; um valor que é
  um objeto JSON aparece com os próprios campos. Variáveis com `/` no nome (`payments/STRIPE_KEY`)
  viram pastas na listagem.
- Listagem por `LIST` (hvac, node-vault) ou `GET ?list=true` (CLI e cliente Go).
- Também respondem `sys/health`, `sys/seal-status`, `sys/mounts`, `sys/internal/ui/mounts` e
  `auth/token/lookup-self`.

## Testado com

`@azure/keyvault-secrets` e `@azure/identity`, `@aws-sdk/client-secrets-manager`, `node-vault` e
`hvac` (Python), em `test/secret-engine.test.ts`. O E2E (`scripts/e2e-secret-engine.mjs`) liga o
mock pela barra de status do app real e lê o mesmo segredo pelas três APIs.

## Segurança

O mock entrega segredos reais de desenvolvimento a qualquer processo local, como todo emulador.
Para reduzir a superfície: escuta só em loopback, recusa `Host` que não seja local (DNS
rebinding) e recusa qualquer requisição com `Origin`, o que barra páginas abertas no navegador.

## Modo Enterprise (Cloud Proxy)

O modo `enterpriseProxy` busca os segredos no cofre real da empresa, via SSO
corporativo, e os mantém só em memória. A lógica dele fica no módulo **VVPost Enterprise**,
distribuído sob licença comercial num pacote separado. Este repositório (Apache 2.0) só
define os pontos de extensão, em
[`src/main/secret-engine/backend.ts`](../src/main/secret-engine/backend.ts):

- **`SecretBackend`**: de onde os emuladores leem e para onde escrevem (`list`, `get`, `set`,
  `delete` e `close`). O modo `localMock` usa o cofre local (ou `localMock.storageFile`); o modo
  `enterpriseProxy` usa o backend que o módulo devolve. Os SDKs continuam apontando para
  `localhost:4460` com as mesmas três APIs, sem mudança de código.
- **`SecretAuditSink`**: recebe um `SecretAuditEvent` por operação (modo, API emulada, ação,
  nome do segredo, ambiente e resultado), nunca o valor. O evento é gravado antes da resposta
  sair; se a trilha falhar, a operação falha (fail-closed).
- **`EnterpriseSecretsModule`**: o contrato do pacote, com `apiVersion`
  (`ENTERPRISE_API_VERSION`, atualmente 1), `createBackend(context)` e `audit(event)`. O contexto
  traz a raiz do workspace, o bloco `enterpriseProxy` já validado e `openExternal` para o
  login SSO no navegador.

O engine carrega o módulo de `VVPOST_ENTERPRISE_MODULE` (caminho absoluto ou nome de pacote)
ou, sem a variável, do pacote `@vvpost/enterprise` se estiver instalado. Sem módulo, o
engine não liga em `enterpriseProxy` e diz o que falta; com `apiVersion` diferente, recusa o
módulo.

```json
{
  "mode": "enterpriseProxy",
  "enterpriseProxy": {
    "provider": "azureKeyVault",
    "upstreamVaultUrl": "https://corp-vault.vault.azure.net",
    "cacheTtlSeconds": 300,
    "enforceMemoryOnly": true
  }
}
```

### Control Plane opcional

O módulo pode trazer também um `controlPlane` ([pontos de extensão](architecture.md#pontos-de-extensão-para-o-módulo-enterprise)),
com `activity(event)`: o core manda para ele os metadados do que acontece no desktop
(requisição com método, host e status; execuções de cenários e fluxos; Secret Engine e MCP
ligados ou desligados), para a auditoria central. O contrato está em
[`src/main/enterprise/control-plane.ts`](../src/main/enterprise/control-plane.ts). Nenhuma
requisição passa pelo Control Plane.

O `controlPlane` também pode ter `catalog()`: o catálogo centralizado da organização, com os
conectores corporativos que o módulo já sincronizou do Control Plane (o core não fala com o
servidor). O app registra esses documentos com `setSharedConnectors`
(`packages/core/src/connectors/shared.ts`), e todo `loadWorkspace` os carrega antes dos
arquivos do disco, com a mesma validação do schema e sem credencial literal. São somente
leitura: o Catálogo mostra a origem (`shared` no resumo), o editor recusa abrir ou gravar com
o id deles, e um arquivo local com o mesmo id fica de fora com um aviso, para o workspace não
trocar em silêncio o conector da organização. Para personalizar, crie um conector com
`"extends"` apontando para o compartilhado. O formato `.vvpost` não muda, e sem módulo a
lista é vazia. `loadWorkspace(dir, { shared })` aceita a lista direto, para o CLI e os
runners.
