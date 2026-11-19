# Modelo de segurança

O VVPost trata segredos como dados de primeira classe: o valor real fica só no
[cofre local](#cofre-local) (cifrado, fora da pasta do projeto) ou em memória, e toda superfície que leva dados para
fora (commits, exports, histórico, CLI, MCP, plugins, webhooks) passa por uma conferência. Esta
página descreve as garantias e os limites de quem dispara requisições sem um humano.

## Cofre local

Os valores reais das variáveis `isSecret` ficam num cofre por pasta de workspace (ou de projeto),
fora dela: em `<userData>/vault` (no Linux, `~/.config/vvpost/vault`; `VVPOST_VAULT_DIR` troca),
um arquivo por pasta, cifrado com AES-256-GCM e só o dono lê e escreve. A chave é uma por usuário
do sistema e fica no cofre do sistema:

| Sistema | Onde fica a chave |
| --- | --- |
| macOS | Keychain (pelo `security`) |
| Windows | DPAPI do usuário, a proteção do Gerenciador de Credenciais (pelo PowerShell) |
| Linux | Secret Service: GNOME Keyring ou KWallet (pelo `secret-tool` da libsecret) |
| Sem cofre do sistema (contêiner, Linux sem libsecret) | Arquivo `vault.key` na pasta do cofre, só do dono. Quando o cofre do sistema aparece, a chave passa para ele e o arquivo some |

O app, o CLI e o servidor MCP leem o mesmo cofre. Backup, sync ou `git add -f` da pasta do projeto
não levam nenhum valor, e o arquivo do cofre sozinho não abre. Um cofre cifrado com outra chave
(outra sessão sem acesso ao Keychain, por exemplo) dá erro em vez de virar vazio, e não é
sobrescrito. `VVPOST_VAULT_KEY` (32 bytes em base64) dá a chave direto, para quem precisa.

O formato antigo, `.vvpost/secrets.local.json` em texto puro dentro do projeto, migra sozinho na
primeira leitura: os valores entram no cofre (vencendo os que já estavam), o cofre é conferido e o
arquivo é apagado. No CI não há cofre: os segredos chegam por `VVPOST_SECRET_<VAR>` ou
`--secrets` ([CLI](cli.md)).

## Secret Sanitizer

Tudo o que vai para a IA pelo MCP, para o terminal e os relatórios do CLI, para o histórico e para
as exportações passa pelo Secret Sanitizer: cada valor conhecido do vault, cada token obtido pela
auth e cada campo de credencial é trocado por `[REDACTED_SECRET]` antes de sair. A IA lê schemas e
respostas, roda cenários e edita o projeto, mas nenhuma credencial chega a ela pelo VVPost, e a
auth é aplicada pelo próprio VVPost ([MCP](mcp.md)). O que essa garantia cobre, e o que fica de fora,
está em [ler um segredo e usar um segredo](#ler-um-segredo-e-usar-um-segredo) e em
[o que não é garantido](#o-que-não-é-garantido).

## Ler um segredo e usar um segredo

São duas proteções diferentes, e o VVPost dá garantias diferentes para cada uma.

**Ler.** Nenhum valor de segredo sai do VVPost para o agente. Vale para todo caminho de saída do
servidor MCP: o resultado de cada ferramenta e a mensagem de cada erro (inclusive erro de rede e
de validação), as respostas HTTP (corpo, headers, `Set-Cookie` e os campos de `select`), a requisição montada no `plan`,
os logs do nó Python e a saída de cada nó em `execute_flow`, os eventos de webhook, as páginas, o
documento do projeto e as referências achadas por `find_references` ou trocadas por `replace_references` (inclusive um valor que alguém
colou numa página ou na descrição de um fluxo), os resources e os prompts. O mesmo vale para o
terminal e os relatórios do CLI e para o histórico. Nós de plugin não rodam pelo MCP. Cada caminho
tem teste em `test/secret-leaks.test.ts`, com valores gerados a cada execução e procurados puros,
em JSON, URL-encode, form-encode, base64 e hex.

**Usar.** O agente pode disparar requisições com a auth de um conector sem conhecer a credencial:
é para isso que ele roda cenários e `execute_dry_run`. O VVPost limita esse uso, mas não o impede:

| O agente tenta | O que acontece |
| --- | --- |
| Mandar a credencial para outro host | Recusado: com conector, só caminhos na origem da `baseUrl`, e um redirect para outra origem perde os headers de credencial. |
| Trocar a auth, a `baseUrl`, a URL do token ou um header de credencial, ou pôr `{{SEGREDO}}` num corpo, query ou header | O conector fica marcado e só aceita `plan: true` até você revisar no app (ou `--approve-review`). |
| Referenciar `{{SEGREDO}}` nos `overrides` ou nas asserções | Recusado. |
| Escrever `{{SEGREDO}}` num fluxo, ou um nó Python ou de plugin | `{{SEGREDO}}` é recusado; o código só roda depois da sua revisão. |
| Disparar num ambiente de produção | Só `plan: true`, mesmo com `--allow-env`. |
| Criar um endpoint novo na mesma origem e chamá-lo com a auth herdada, ou chamar um endpoint de escrita (`POST`, `DELETE`) que já existe | **Permitido** dentro dos limites: `--allow-methods GET,HEAD` deixa só leitura, `--allow-env` escolhe os ambientes, `--rate` limita a taxa e `--read-only` não envia nada. |

Para um agente que não deve alterar dados de verdade, rode o MCP com `--allow-methods GET,HEAD` (ou
`--read-only`) e deixe os ambientes com dados reais protegidos.

O que fica fora das duas garantias está em [o que não é garantido](#o-que-não-é-garantido).

## Dados pessoais para o agente

O Secret Sanitizer cuida de credenciais. Dados pessoais (CPF, e-mail, telefone, cartão) que uma
API devolve são dado de negócio e, sem marcação, chegam à IA como chegam ao app. Para que não
cheguem, marque os campos nos schemas do projeto com `x-sensitive`:

```json
{
  "type": "object",
  "properties": {
    "cpf": { "type": "string", "x-sensitive": "cpf" },
    "nome": { "type": "string", "x-sensitive": "name" },
    "emails": { "type": "array", "items": { "type": "string", "x-sensitive": "email" } },
    "endereco": { "$ref": "schema:Endereco", "x-sensitive": "address" }
  }
}
```

O valor é `true` ou o tipo: `cpf`, `cnpj`, `email`, `phone`, `card`, `rg`, `name`, `address`,
`birthDate` ou `document` (`true` e um tipo desconhecido viram `pii`). A marca vale em qualquer
schema do projeto: [schemas compartilhados](catalog.md#schemas-compartilhados), `bodySchema` e o
schema de um exemplo de resposta. O import do OpenAPI a mantém, e o export para OpenAPI a devolve.

**Como mascara.** O servidor MCP junta os nomes marcados no workspace e troca o valor desses
campos por `[REDACTED_PII:<tipo>]`, em qualquer profundidade, antes do Secret Sanitizer e antes de
cortar o preview. A regra é pelo nome do campo, como a dos campos de credencial: um `email`
marcado num schema é mascarado em todas as respostas, de qualquer endpoint (erra para o lado
seguro). Um campo marcado que é objeto ou lista some inteiro. Vale também em JSON cortado, em
`chave=valor` de query e de form, e no header de mesmo nome.

**Onde vale.** Em todo dado de execução que vai à IA: o corpo, os headers e os campos de `select`
das respostas do `execute_dry_run`, a URL e o corpo montados no `plan`, o valor encontrado e o
esperado de cada asserção (também dentro da mensagem), os `captures`, a saída, os logs e o erro de
cada nó do `execute_flow`, e a URL, a query, os headers e o corpo dos eventos de webhook. As
asserções da IA rodam sobre a resposta já mascarada: um `equals` com o CPF verdadeiro falha, e o
passou/falhou não revela o valor. O que a IA lê do próprio projeto (`get_source`, a documentação,
um exemplo escrito no arquivo) não muda: é o que o time versionou.

**Para o humano, por padrão nada muda.** O app (Quick Request, cenários, Flow Studio, histórico) e
o CLI mostram os valores reais, a menos que o time ou a organização peçam o contrário (abaixo, em
[Dados pessoais para pessoas](#dados-pessoais-para-pessoas)).

**Detecção por padrão.** Para campos sem marca, o VVPost reconhece pelo formato: CPF e CNPJ com
dígito verificador, cartão de bandeira conhecida que passa no Luhn, e-mail e telefone com DDD e
separador (ou `+55...`). Vem desligada, porque um formato também pega o que não é dado pessoal (um
e-mail de sistema, por exemplo). Liga em `.vvpost/privacy.json`, versionado com o workspace (vale
para o time; num projeto, valem o do projeto e o da raiz):

```json
{ "$schema": "https://vvpost.dev/schemas/v1/privacy.json", "agent": { "detect": ["cpf", "email"] } }
```

`"detect": true` liga todos os tipos. Também liga com `--pii-detect` (ou `--pii-types cpf,email`) no
`mcp.js`, e pela política Enterprise (`agentPiiDetection`, abaixo). Vale o mais forte: nada desliga
o que outro ligou, e nada desliga o mascaramento dos campos marcados. Um `privacy.json` inválido
faz as ferramentas recusarem com `INVALID_CONFIG`, em vez de seguirem sem detecção.

**A IA não tira a marca.** `edit_project` (e toda escrita da IA no projeto) recusa um lote que tira
`x-sensitive` de um campo; acrescentar pode. Quem tira é você, no app ou no arquivo.

**Política Enterprise.** Com o módulo Enterprise, o campo `agentPiiDetection` da política do Control
Plane (da organização ou do projeto) liga a detecção no servidor MCP do app e no `mcp.js`, como parte
da [política central do agente](mcp.md#política-central-módulo-enterprise). Sem a política (sem login,
Control Plane fora), o servidor fica no modo mais restrito, que também mascara pelo formato.

Limites: a marca é por nome, então um dado pessoal num campo sem marca, com um formato que a detecção
não conhece (um nome em texto livre, um endereço), passa. Para dados reais de clientes, a regra
continua: aponte a IA para ambientes com dados de teste, e use `x-sensitive` como a segunda barreira.

## Dados pessoais para pessoas

O mesmo mascaramento pode valer para quem usa o app e o CLI: útil quando o time testa contra um
ambiente com dados reais e quem está na tela não deve vê-los (suporte, demonstração, gravação de
tela). Liga de dois jeitos:

- no `.vvpost/privacy.json` do workspace, versionado, para o time:

  ```json
  { "$schema": "https://vvpost.dev/schemas/v1/privacy.json", "people": { "mask": true, "detect": ["cpf"] } }
  ```

  `detect` é opcional e vale só para pessoas (a detecção do agente continua em `agent.detect`);
  sem `mask: true`, nada muda;
- pela organização, desligando o recurso `piiVisible` (como os [recursos desligados](#recursos-desligados),
  pela política do Control Plane ou por `VVPOST_DISABLE_FEATURES=piiVisible`). Aí valem os campos
  marcados com `x-sensitive`, mais a detecção do `people.detect`, se houver.

**Onde vale.** No app: a resposta do Quick Request (corpo, headers, a URL e os headers enviados,
os testes, as variáveis e os logs dos scripts), os resultados dos cenários e dos fluxos, as
mensagens de WebSocket, SSE e Socket.IO, os eventos de webhook e o histórico (a lista, o detalhe e
o que é gravado a partir daí). No CLI: o terminal e os relatórios do `vvpost run` (`--json`,
`--junit`), o histórico do `--history` e as linhas do `vvpost webhooks`. A estrutura não muda: o
nome de um nó, o id de um cenário e o nome de um header ficam, só o valor sai mascarado.

Um `privacy.json` inválido não vira máscara desligada: o `vvpost run` para antes de qualquer
requisição (saída `2`), e o app mascara os campos marcados e registra o erro no log.

**O que não muda.** A rede: a requisição segue com o valor real, e o servidor recebe o que
recebia. O modelo da requisição no histórico fica como foi digitado, para reproduzir. O que está
escrito nos arquivos do projeto (um exemplo, uma variável de ambiente) aparece como está: é o que o
time versionou. E é uma barreira de tela, não de acesso: quem tem as credenciais do ambiente ainda
pode chamar a API por fora do VVPost.

## Limites de disparo

Toda ferramenta que dispara requisições sem um humano conferindo cada uma passa por um
`RequestGuard` (`packages/core/src/policy/request-policy.ts`), aplicado em `sendHeadless` depois da herança e
antes da auth. Recusa vira `POLICY_DENIED` com o motivo; recusas não contam nos limites.

| Regra | O que confere |
| --- | --- |
| `allowMethods` | Métodos HTTP permitidos. |
| `allowEnvironments` | Ambientes permitidos (`""` é sem ambiente). |
| `allowOrigins` | Origens: `https://api.exemplo.com`, `https://*.exemplo.com` (só subdomínios) e `http://localhost:*`. |
| `maxRequests` | Total por execução (uma chamada de nó). |
| `rate` | Janela deslizante: N requisições em T ms. |
| `maxConcurrent` | Simultâneas; as excedentes esperam a vez (e saem da fila se canceladas). |
| `maxTimeoutMs` | Teto do timeout pedido pelo chamador. |

| Quem dispara | Política |
| --- | --- |
| Usuário (Quick Request, cenários, Flow Studio) | Sem guard: um humano disparou. Valem o timeout do dispatcher e a regra de origem do conector (abaixo). |
| IA pelo MCP (`execute_dry_run`) | Um guard por servidor: 60 requisições por minuto, 4 simultâneas, timeout até 60 s. `--allow-methods` limita os métodos (bloqueados antes de enviar, com `plan: true` livre), `--allow-env` os ambientes (um [ambiente protegido](#ambientes-protegidos) só aceita `plan: true` mesmo liberado), `--rate` a taxa e `--read-only` não envia nada. Até 50 execuções por chamada. A IA só alcança endpoints de conectores, não URLs livres, e não referencia variáveis secretas. Conector com auth, destino ou credenciais alterados pela IA (`edit_project`) só aceita `plan: true` até o usuário revisar. |
| IA pelo MCP (`edit_project`, `import_postman`) | Não dispara nada. Até 2000 operações por lote, atômico; `--no-write` (ou `--read-only`) desliga a edição. |
| Plugins (`ctx.http.send`) | Um guard por execução de nó: 100 requisições, 6 simultâneas, timeout até 120 s. |
| Plugins (rede própria) | Só os hosts de `permissions.network` no manifesto; sem o campo, nenhum (no Linux com user namespaces, num namespace de rede vazio). O processo lê só a pasta do plugin, sem gravar nem abrir subprocessos ([plugins.md](plugins.md#modelo-de-confiança)). |
| Nó Python | Só os hosts de `python.network` no nó; sem o campo, nenhum, também sem subprocessos e ctypes (audit hook do Python e, no Linux, namespace de rede vazio) ([flows.md](flows.md#nó-python)). |
| Hook do servidor de webhooks (`trigger`) | Um guard por servidor: 60 requisições por minuto, 4 simultâneas, timeout até 60 s. Até 2 disparos ao mesmo tempo e 20 na fila; além disso o evento é pulado. Fluxo com código não revisado, ou conector com auth ou destino alterados pela IA, não dispara ([webhooks](webhooks.md)). |
| Secret Engine Enterprise | Regra do módulo: só hosts oficiais do provedor ou aprovados pela organização. |

Regras que valem para todos: com conector, uma URL absoluta só é aceita na origem da `baseUrl`
(credenciais herdadas não vão para outro host), e um redirecionamento para outra origem perde todo
header de credencial: `Authorization`, `Cookie`, os de nome sensível (`X-Api-Key`, `*-Token`...) e o
header da auth do conector, qualquer que seja o nome. O guard governa o canal do host; a rede
própria de um plugin ou do nó Python é governada pela sandbox de processo, que só deixa sair para
os hosts declarados.

## Ambientes protegidos

Um ambiente de produção é protegido por padrão: o id ou o nome tem a palavra `prod`, `prd`,
`production`, `producao`, `produção` ou `live` (`env.prod`, "Produção", `prd-eu`). O arquivo do
ambiente decide nos dois sentidos com `"protected"`: `true` protege um ambiente de nome qualquer e
`false` libera um que pareça de produção.

| Quem dispara | Num ambiente protegido |
| --- | --- |
| Usuário no app (Quick Request, cenários, Flow Studio, reprodução do histórico) | Confirma antes de cada disparo, com o nome do ambiente. |
| IA pelo MCP (`execute_dry_run`, `execute_flow`) | Só `plan: true`: monta, valida e mostra as requisições, sem enviar. Vale mesmo com o ambiente em `--allow-env`. `get_api_catalog` marca o ambiente com `protected: true`. |
| Hook do servidor de webhooks | Não dispara: o evento fica como pulado, com o motivo. |
| CLI (`vvpost run`, `vvpost flow`) | Sem mudança: quem roda o comando escolheu o ambiente. |

## Garantias contra vazamento de segredos

Um segredo é todo valor do [cofre local](#cofre-local), toda credencial obtida por um fluxo de
auth e todo campo de credencial (header ou campo de nome sensível, `isSecret: true`). As garantias,
cada uma com teste automatizado em `test/secret-leaks.test.ts` (valores gerados a cada execução e
procurados puros, em JSON, URL-encode, form-encode, base64 e hex):

| Superfície | Garantia |
| --- | --- |
| Commits | Ambientes com segredo em texto puro são redigidos antes do commit e da resolução de conflito, com os valores indo para o cofre local; o `secrets.local.json` antigo, se ainda existir, não pode ser commitado. Depois, o leak guard (`src/main/workspace/leak-guard.ts`) confere cada arquivo do commit e recusa com `SECRET_LEAK` se achar um valor do vault (6 caracteres ou mais), credencial literal num conector ou chave privada PEM. A mensagem cita arquivo e variável, nunca o valor. A resolução de conflito passa pela mesma conferência antes de entrar no index. Commits feitos fora do app (terminal, IDE) passam pela mesma conferência com o hook de pre-commit (`vvpost guard --install`, ou "Conferir segredos também nos commits fora do app" no menu do Git), que confere o index contra os vaults de todos os projetos do workspace e recusa o commit; sem o CLI encontrado, o hook recusa em vez de pular. |
| Exports | O import do Postman grava segredos só no vault; os arquivos gravados e a prévia mandada à interface não têm nenhum. Conectores salvos pelo app recusam credencial literal. O MCP devolve só dados sanitizados ([MCP](mcp.md)). |
| Edição pela IA | `edit_project` e `import_postman` não gravam valor de segredo (nem no vault) e recusam, sem ecoar o valor, arquivo com valor do vault, credencial literal ou credencial que o sanitizer conhece; `[REDACTED_SECRET]` lido pela IA volta ao valor que estava no arquivo. |
| Rede | Um redirecionamento para outra origem não leva headers de credencial nem o header da auth do conector ([limites de disparo](security-model.md#limites-de-disparo)). |
| CLI | O terminal, o JUnit e o JSON do `vvpost run` passam pelo Secret Sanitizer, com os segredos do workspace, os que o CI injeta (`VVPOST_SECRET_*`, `--secrets`) e os tokens obtidos pela auth; nada é gravado no workspace ([CLI](cli.md)). |
| Webhooks | A chave da assinatura de um hook só pode ser uma referência `{{VAR}}` (o schema recusa valor literal) e é lida do vault na hora de conferir; nunca entra no evento, nas respostas do servidor, nas mensagens nem nos hooks mostrados. O que o remetente manda (headers, query, corpo) sai pelo MCP (`list_webhook_events`, `get_webhook_event`) e pelo `vvpost webhooks` só sanitizado; os eventos ficam só em memória ([webhooks](webhooks.md)). |
| Logs | O histórico (SQLite) troca por `__REQUIRED_SECRET__`, no modelo da requisição, os headers sensíveis, os parâmetros de query e os campos do corpo (JSON ou formulário) de nome de credencial, e guarda `{{VAR}}` como `{{VAR}}`; a requisição resolvida, a resposta, as asserções, os logs e o relatório passam pelo Secret Sanitizer com os segredos do workspace e os tokens vistos no dispatcher, em todos os níveis. O teste lê o banco e o WAL byte a byte. Carregar o workspace não escreve no console, e o teste captura console e stderr de todas as superfícies. |

## Recursos desligados

Alguns recursos abrem uma superfície própria na máquina: código de terceiros (plugins), um
processo Python, scripts JavaScript, um servidor escutando numa porta local (Secret Engine no modo
mock, servidor mock, webhooks, MCP) ou um protocolo além do HTTP. Cada um pode ser desligado por
inteiro, no app, no CLI e no MCP ao mesmo tempo:

| Id | O que desliga |
| --- | --- |
| `secretEmulator` | O Secret Engine no modo mock (o emulador local das APIs de cofre) |
| `pythonNode` | O nó Python do Flow Studio |
| `scripts` | Os scripts pre e post das requisições (e o plugin JavaScript que os roda) |
| `plugins` | Os plugins instalados pelo usuário: não rodam nem instalam |
| `protocols` | WebSocket, SSE e Socket.IO, e os adapters de plugin (GraphQL, gRPC, Kafka) |
| `mockServer` | O servidor mock |
| `webhooks` | O servidor local de webhooks e o nó webhook |
| `mcp` | O servidor MCP: as ferramentas respondem `POLICY_DENIED` |
| `piiVisible` | Dados pessoais à vista no app e no CLI: desligado, eles saem mascarados ([dados pessoais para pessoas](#dados-pessoais-para-pessoas)) |

Quem desliga: a variável `VVPOST_DISABLE_FEATURES` (ids separados por vírgula), em qualquer build,
e, com o módulo Enterprise, a política da organização (`controlPlane.features`). As duas só somam:
nada religa o que a outra desligou. A recusa tem o código `POLICY_DENIED` e diz o recurso e de
onde veio a decisão; um servidor ligado para quando a política o desliga, e o app lista o que está
desligado em **Configurações**. Com o workspace declarando a organização
(`.vvpost/organization.json`) e sem política lida nesta máquina, todos os recursos da lista ficam
desligados até ela chegar, como no [MCP](mcp.md#política-central-módulo-enterprise).

Isso reduz a superfície do VVPost instalado; não impede quem controla a máquina de rodar outro
binário.

## O que não é garantido

As garantias acima são sobre **ler** um segredo: o valor não sai do cofre para a IA, o terminal, os
relatórios, o histórico, os exports nem os commits. **Usar** a auth é outra coisa. A IA não conhece o
token, mas pode disparar requisições autenticadas pelos conectores, porque é assim que ela testa.
Esse uso é limitado (origem da `baseUrl`, ambientes protegidos, métodos, taxa, revisão de auth,
destino e código), não proibido. Os limites que valem saber:

| Limite | O que fazer |
| --- | --- |
| Num ambiente não protegido, com os métodos liberados, a IA faz escrita de verdade na API (é o teste) | `--allow-methods GET,HEAD` para só ler, `--allow-env` para os ambientes de teste, `--read-only` para nada sair, e `"protected": true` em qualquer ambiente sensível |
| Os dados de negócio que a API devolve chegam à IA; as credenciais são mascaradas sempre, os dados pessoais só quando marcados com `x-sensitive` ou reconhecidos pela detecção | Aponte a IA para ambientes com dados de teste e marque os campos pessoais ([dados pessoais](#dados-pessoais-para-o-agente)) |
| Um segredo que a API devolve transformado (com hash, cifrado, invertido) não é reconhecido | |
| Um segredo com menos de 4 caracteres só é mascarado quando é o valor inteiro | Use segredos de tamanho real |
| Código que a pessoa aprovou (nó Python, plugin) roda com a rede que declara | Revise o código no painel de revisão antes de aprovar ([plugins](plugins.md#modelo-de-confiança)) |
| Um token que um endpoint comum devolve (sem passar pela auth do conector) não é um valor que o VVPost conhece | Ele é mascarado pelo nome do campo (`token`, `access_token`, `session`...) ou pelo formato (JWT, `Bearer ...`); um nome neutro e um formato próprio passam. Prefira obter tokens pela auth do conector |
| O modelo de ameaça é o de um cliente que só fala com o VVPost pelo MCP. Um agente que roda como o seu usuário e também tem terminal ou leitura de arquivos alcança o que você alcança, por fora do VVPost (abaixo) | Dê ao agente só a pasta do código e o MCP, ou rode o cliente num contêiner ou usuário sem o seu cofre |

O cofre fecha o vazamento por acaso: o arquivo fica fora da pasta do projeto e é cifrado, então um
agente que lê o projeto, o `.vvpost` ou a própria pasta do cofre não acha credencial nenhuma (é o que
o [benchmark](benchmark-agentes.md) mede). O que o cofre não fecha é um agente que roda como o seu
usuário, tem terminal e decide ir atrás da chave. Por fora do VVPost, ele chega a:

- **A chave do cofre.** Ler o arquivo do cofre não basta: é preciso pedir a chave ao cofre do sistema
  com um comando próprio e decifrar o arquivo. O cofre do sistema entrega a chave a qualquer processo
  do mesmo usuário sem confirmação: no Keychain do macOS (o item é criado pelo `security`, e o
  próprio `security` o lê sem perguntar), no DPAPI e numa sessão do Secret Service já destravada.
  Sem cofre do sistema (contêiner, Linux sem libsecret), a chave fica no arquivo `vault.key`, ao lado
  do cofre, e aí ler arquivos do seu usuário já basta.
- **O mock de cofres.** Ele vem desligado. Ligado pelo botão **Secrets**, serve os valores do cofre em
  `127.0.0.1:4460` para os SDKs locais, sem senha, porque é para isso que ele existe; recusa
  navegadores e hosts fora de `localhost`, mas qualquer processo local lê enquanto ele estiver
  ligado. Desligue quando não estiver usando.
- **O ambiente do terminal.** `VVPOST_SECRET_*` e o arquivo de `--secrets` do CI ficam visíveis a
  quem roda no mesmo shell.

Teste novo de superfície nova: quem cria um caminho de saída (arquivo, IPC, log, rede para a IA)
acrescenta o caso em `secret-leaks.test.ts`.

Achou um caminho que escapa dessas garantias? Siga a [política de segurança](../SECURITY.md).
