# Plugin SDK e Extensions Hub

Plugins acrescentam ao Flow Studio dois tipos de contribuição, e à documentação mais dois:

- **Tipos de nó**: um passo do fluxo que recebe a configuração e a saída dos nós anteriores
  (`$nodes`) e devolve um valor, que vira `$nodes.<nome>.data`.
- **Adapters de protocolo**: uma chamada num protocolo que não é HTTP puro (GraphQL, gRPC,
  Kafka). A saída tem `data`, `status` e `headers` como a de um nó de requisição, e o adapter
  herda baseUrl, headers, auth e mTLS do conector do nó. Um adapter também é um protocolo do
  [Quick Request e dos cenários de teste](#protocolos-no-quick-request-e-nos-cenários).
- **Exportadores da documentação**: um formato a mais no **Enviar para…** e no `vvpost docs
  export` ([abaixo](#exportadores-da-documentação)).
- **Publicadores da documentação**: um destino remoto a mais no **Enviar para…** (uma wiki, um
  portal), com a conta da pessoa ([abaixo](#publicadores-da-documentação)).

Cada plugin roda num **processo** só dele, com as permissões que declara. O VVPost traz cinco
plugins oficiais, e outros são instalados pelo **Extensions Hub**: de um registro, de um pacote
`.zip`/`.tgz` ou de uma pasta, com assinatura Ed25519 conferida antes de instalar.

| Plugin oficial | Contribui | Para quê |
| --- | --- | --- |
| [`vvpost-plugin-javascript`](../plugins/vvpost-plugin-javascript) | nós `javascript.script` e `javascript.request-script` | Transformar e combinar respostas com JavaScript (`return` ou `output`), com `await http.send(...)` |
| [`vvpost-plugin-graphql`](../plugins/vvpost-plugin-graphql) | adapter `graphql` | Query ou mutation com variáveis (GraphQL over HTTP), pela auth headless do conector |
| [`vvpost-plugin-grpc`](../plugins/vvpost-plugin-grpc) | adapter `grpc` | Chamadas unárias e de streaming sobre HTTP/2, com os tipos de um `.proto` colado ou do server reflection |
| [`vvpost-plugin-kafka`](../plugins/vvpost-plugin-kafka) | adapter `kafka` | Produzir, consumir e listar tópicos, com SASL (PLAIN, SCRAM, OAUTHBEARER), TLS e as compressões do Kafka |
| [`vvpost-plugin-mkdocs`](../plugins/vvpost-plugin-mkdocs) | exportador `mkdocs` | A documentação como projeto MkDocs, o formato do Backstage TechDocs |

## Modelo de confiança

Leia antes de instalar ou escrever um plugin.

**Um plugin roda numa sandbox do runtime, com o que o manifesto declara.** O processo do plugin
sobe com o [modelo de permissões do Node](https://nodejs.org/api/permissions.html) ligado e a
guarda de rede do VVPost instalada antes do código do plugin:

| O plugin pode | O plugin não pode |
| --- | --- |
| Ler os arquivos da própria pasta (o `main`, `node_modules`) | Ler outros arquivos (o workspace, o cofre local, a pasta de usuário) |
| Mandar requisições por `ctx.http.send`, pelo host, com a auth do conector | Gravar arquivos, abrir subprocessos, Worker Threads, addons nativos, WASI ou `process.binding` |
| Conectar aos hosts de `permissions.network` (TCP, TLS, HTTP/2, `fetch`, WebSocket) | Conectar ou resolver por DNS outros hosts, usar UDP, sockets locais ou abrir um servidor (só com `"*"`) |

A guarda de rede confere o host no `net.Socket` e de novo no handle nativo: um IP só passa se
estiver nas regras ou tiver vindo de uma consulta DNS de um host permitido. Os pontos trocados
ficam congelados. Um plugin sem rede declarada, no Linux com user namespaces sem privilégios
(o normal no Fedora, no Debian e no Arch; o Ubuntu 24.04 restringe pelo AppArmor), roda ainda
num **namespace de rede vazio**: ali nem um socket bruto sai, porque a barreira é do kernel. O
Extensions Hub diz quando essa camada está ativa; `VVPOST_NETNS=0` a desliga.

Nas outras situações a barreira é do runtime: ela fecha os caminhos documentados do Node, mas não
é uma fronteira do sistema operacional, e código escrito para burlá-la é um risco que só a
confiança no autor resolve. Por isso:

1. **Só você instala plugins.** Os oficiais vêm com o app. Os outros entram pelo Extensions Hub
   (de um registro, de um arquivo ou de uma pasta), que mostra id, versão, autor, arquivos, o
   que o plugin contribui, a rede que ele pede e quem o assinou antes de copiar qualquer coisa.
   Instale só plugins de quem você confia, e desconfie de um plugin que pede `"*"` sem motivo.
   A [assinatura](#assinatura) diz que o plugin não mudou desde que a chave do autor o
   assinou; ela não diz que o autor é confiável.
2. **Nada roda a partir de um workspace.** O VVPost nunca carrega um plugin de dentro de um
   repositório aberto ou clonado. Um fluxo pode citar um nó de plugin, mas se o plugin não
   estiver instalado e ligado o nó falha com `PLUGIN_UNAVAILABLE`, sem rodar nada.
3. **O token do conector fica no main process.** Quando o plugin envia uma requisição por
   `ctx.http.send`, a auth do conector (bearer, OAuth2, login...) e o mTLS são aplicados no
   host. O plugin recebe só a resposta.
4. **`{{VAR}}` do ambiente é resolvido no host.** A configuração chega ao plugin com
   `{{API_TOKEN}}` literal; o valor só é posto no momento do envio, no main process. Um
   texto vindo de um nó anterior (pela config ou lido de `ctx.nodes`) que contenha `{{...}}`
   segue literal no envio: o texto de uma resposta não vira um segredo do ambiente (a mesma
   regra do nó de requisição). Um plugin que escreva `{{API_TOKEN}}` numa requisição a um
   servidor que devolve o que recebe ainda consegue o valor: veja o item 1.
5. **O processo começa com o ambiente vazio.** `process.env` no plugin não tem as variáveis do
   app nem do sistema (nem `NODE_OPTIONS`).
6. **Limites por processo.** Heap de até 256 MB, tempo por chamada (padrão 30 s, `timeoutMs` no
   nó). Um timeout ou cancelamento aborta `ctx.signal`; se o código não parar em 1 s (um laço
   infinito, por exemplo), o processo é encerrado. Estourar a memória ou lançar uma exceção fora
   da chamada derruba só aquele processo: o nó falha com `PLUGIN_CRASHED` e o próximo uso sobe
   outro. O app e os outros plugins seguem.
7. **Limites de rede pelo host.** Numa execução do nó, `ctx.http.send` aceita até 100
   requisições, 6 ao mesmo tempo, com timeout de até 120 s; passar disso rejeita com
   `POLICY_DENIED` ([limites de disparo](security-model.md#limites-de-disparo)). A rede própria do plugin, quando declarada, fica fora desses
   limites, mas presa aos hosts declarados.
8. **Os dados do fluxo vão para o plugin.** O plugin recebe a saída dos nós anteriores ao nó
   dele (`ctx.nodes`), como o nó Python.

### Rede declarada

Um plugin que fala um protocolo próprio (gRPC, Kafka, um SDK de nuvem) declara no manifesto os
hosts a que conecta:

```json
"permissions": { "network": ["connector", "config:brokers", "*.confluent.cloud:9092"] }
```

| Regra | Libera |
| --- | --- |
| `api.example.com`, `10.0.0.5`, `[::1]` | O host (qualquer porta) |
| `api.example.com:443` | O host só nessa porta |
| `*.example.com` | Os subdomínios (não o próprio `example.com`) |
| `connector` | O host da `baseUrl` do conector do nó, com as variáveis do ambiente resolvidas |
| `config:<campo>` | Os hosts escritos no campo da configuração do nó (ex.: `b1:9092, b2:9092`, ou URLs) |
| `*` | Qualquer host, UDP, sockets locais e servidores: a rede do usuário |

Sem `permissions`, o plugin não tem rede própria. Uma conexão fora das regras falha com
`POLICY_DENIED` e a mensagem diz o host. Mudar as permissões (reinstalando o plugin) reinicia o
processo dele.

Um protocolo que não passa por `ctx.http.send` (gRPC, Kafka) precisa das credenciais do
conector no próprio plugin. Para isso o manifesto declara `"connectorCredentials": true`, e o
adapter recebe `ctx.connection`: a baseUrl resolvida, os headers com a auth já aplicada (o
token de um OAuth2, por exemplo), as credenciais (`auth.username`/`password` de uma auth basic,
`auth.token` das outras) e o mTLS do conector. É uma exceção ao item 3 acima, e por isso tem
uma trava: um plugin com `connectorCredentials` só pode declarar `connector` e `config:<campo>`
em `network`, então as credenciais só seguem para o host do conector ou para os hosts que o
usuário escreveu no nó. O Extensions Hub mostra "recebe as credenciais do conector do nó" nas
permissões.

O nó `javascript.script` roda o script do usuário num contexto do `node:vm` sem `require`,
`process` nem `fetch`. Isso evita usos acidentais, mas o `node:vm` também não é uma fronteira
de segurança: o script tem, na prática, o mesmo acesso que o plugin. Rode scripts em que
você confia, como faria num terminal.

## Extensions Hub

O painel lista os plugins oficiais e os instalados, com o estado do processo de cada um (parado,
subindo, ativo), o que cada um contribui, a rede que declara, a assinatura, de onde veio e a
última falha do processo. Nele você:

- **liga e desliga** um plugin (também os oficiais). Desligar encerra o processo, e os nós
  dele passam a falhar com `PLUGIN_UNAVAILABLE`;
- **instala de um arquivo** (`.zip`, `.tgz`, `.tar.gz` ou `.tar`): o pacote é extraído numa pasta
  temporária (`<userData>/plugins.staging`), e a prévia é a mesma da pasta. Um pacote com tudo
  dentro de uma pasta só (como o `package/` do `npm pack`) usa essa pasta como raiz. O pacote é
  recusado inteiro se tiver links, caminhos absolutos ou com `..`, nomes repetidos, `.zip` com
  senha ou zip64, ou passar de 5000 arquivos ou 100 MB;
- **instala de um registro** (seção **Registros**): você adiciona a URL do índice, o painel lista
  os plugins dele com a versão instalada, e **Instalar** ou **Atualizar para X** baixa o pacote,
  confere o SHA-256 e mostra a prévia;
- **instala de uma pasta**: o app lê o `vvpost-plugin.json`, mostra a prévia e, se você
  confirmar, copia a pasta (sem `.git`) para `<userData>/plugins/<id>`;
- **remove** um plugin instalado (os oficiais só podem ser desligados), e **deixa de confiar**
  numa chave (seção **Chaves confiáveis**).

Instalar de novo o mesmo id substitui a versão anterior. A prévia é a única coisa que pode ser
instalada: se a pasta ou o pacote mudar entre a prévia e o clique (outro id, outra versão, outra
assinatura), a instalação é recusada. Na pasta instalada, `.vvpost-install.json` guarda a origem e
a assinatura conferida.

### Assinatura

Um plugin assinado traz `vvpost-plugin.sig.json` na raiz: o SHA-256 de cada arquivo da pasta,
o id e a versão, e uma assinatura Ed25519 sobre tudo isso, com a chave pública junto. Na
prévia, o app recalcula os hashes e confere a assinatura:

| Assinatura | Na prévia | Instala? |
| --- | --- | --- |
| Válida, chave confiável ou fixada pelo registro | "assinado por Acme (impressão digital)" | Sim |
| Válida, chave desconhecida | Mostra a impressão digital e oferece **Confiar nesta chave** | Sim |
| Sem assinatura | Avisa que nada garante quem escreveu nem que o plugin não mudou | Sim (de pasta, de arquivo e de registro sem chave fixada) |
| Inválida (arquivo mudado, acrescentado ou faltando, outro id/versão, assinatura que não confere) | O motivo | Não |

Duas regras protegem as atualizações:

- **A chave que assinou a versão instalada tem de assinar a nova.** Uma atualização sem
  assinatura, ou de outra chave, é recusada; se a troca de chave for esperada, remova o plugin
  e instale de novo.
- **Um registro pode fixar a chave** de um plugin ou de uma versão (`publicKey` no índice):
  então o pacote precisa estar assinado por ela, e a prévia mostra "assinado por registro
  <nome>".

Confira a impressão digital com o autor por outro canal antes de confiar numa chave. As chaves
confiáveis ficam em `<userData>/plugins.json`.

### Registro

Um registro é um JSON estático servido por HTTPS (HTTP só em `localhost`), por exemplo num
GitHub Pages ou num bucket. As URLs dos pacotes podem ser relativas ao índice.

```json
{
  "version": 1,
  "name": "Acme Plugins",
  "plugins": [
    {
      "id": "acme-greeter",
      "name": "Acme Greeter",
      "description": "Saudações",
      "author": "Acme",
      "publicKey": "<chave pública Ed25519 em base64, do vvpost plugin keygen>",
      "versions": [
        { "version": "1.2.0", "url": "acme-greeter-1.2.0.zip", "sha256": "<sha256 do pacote>" }
      ]
    }
  ]
}
```

O painel instala a versão mais nova que não é pré-lançamento. O pacote precisa ter o id e a
versão que o índice anuncia e o SHA-256 dele; com `publicKey` (no plugin ou na versão), a
assinatura daquela chave. Não há registro oficial configurado: os registros são os que você
adiciona.

Dois plugins ligados não podem contribuir o mesmo tipo de nó ou o mesmo protocolo: o
segundo fica com erro de conflito até você desligar um deles. Um id de plugin oficial não
pode ser instalado por cima.

O gerenciador de plugins é um chunk do main process carregado no primeiro uso do Extensions
Hub ou de um fluxo com nó de plugin. Nenhum processo sobe no boot: plugins instalados não pesam
na abertura do app nem na RAM em repouso.

## Nós de plugin no fluxo

No Flow Studio, o seletor **+ Plugin…** lista as contribuições dos plugins ligados. O inspetor
monta o formulário a partir dos campos do manifesto. No arquivo do fluxo o nó fica assim
(schema [`flow.json`](../packages/schemas/schemas/flow.json), `FlowPluginNode`):

```json
{
  "id": "user", "name": "User", "type": "plugin",
  "plugin": {
    "adapter": "graphql",
    "connector": "connector.api",
    "config": {
      "url": "/graphql",
      "query": "query ($id: Int!) { user(id: $id) { id name } }",
      "variables": { "id": "{{ $nodes.Session.data.userId }}" }
    }
  }
}
```

- `plugin.node` (um tipo de nó, ex.: `javascript.script`) **ou** `plugin.adapter` (um protocolo).
- `connector` e `ignoreHttpErrors` só valem com `adapter`.
- `timeoutMs`: padrão 30000.
- `config`: os campos do manifesto. Campos ausentes usam o `default`; `required` vazio é
  `CONFIG_ERROR`. Textos com `{{ $nodes... }}` recebem os valores dos nós anteriores (um texto
  que é só a referência vira o valor com o tipo dele), exceto nos campos com
  `"templates": false`. `{{VAR}}` do ambiente fica literal até o envio pelo host.

| Erro do nó | Quando |
| --- | --- |
| `PLUGIN_UNAVAILABLE` | Nenhum plugin ligado contribui o tipo ou protocolo; o plugin está com conflito ou o main dele não carregou |
| `PLUGIN_ERROR` | O código do plugin lançou um erro (a mensagem vem com o `code` do erro, se houver), ou devolveu algo que não é JSON |
| `PLUGIN_CRASHED` | O processo caiu (exceção fora da chamada, memória) ou foi encerrado por uma chamada travada |
| `TIMEOUT`, `ABORTED` | Passou de `timeoutMs`, ou o fluxo foi cancelado |
| `CONFIG_ERROR` | Campo obrigatório vazio, tipo errado, conector inexistente |
| `HTTP_STATUS` | O adapter devolveu `status` 4xx/5xx e o nó não marca `ignoreHttpErrors` |

`console.log` e `ctx.log` do plugin aparecem nos logs do nó, no inspetor.

### Plugins declarados no workspace

O `vvpost.plugins.json`, na raiz do workspace (ao lado do Compartilhado, valendo para todos os
projetos), diz quais plugins os fluxos e endpoints usam e que versão de cada um serve. Assim, quem
clona o repositório ou roda o CI sabe o que instalar, e uma versão diferente não roda sem aviso:

```json
{
  "$schema": "https://vvpost.dev/schemas/v1/workspace-plugins.json",
  "plugins": {
    "vvpost-plugin-javascript": "^1.1.0",
    "vvpost-plugin-kafka": "1.0.0"
  }
}
```

A versão pode ser exata (`1.0.0`), compatível (`^1.1.0`: a mesma maior, a partir dela; antes do 1.0,
a mesma menor), da mesma menor (`~1.1.0`), mínima (`>=1.1.0`) ou qualquer (`*`).

`vvpost validate` e `vvpost run` param com o código 2 antes de qualquer requisição, com uma linha por
problema, quando:

- um plugin declarado não está instalado, está desligado, tem erro ou tem uma versão fora da pedida
  (a linha diz a pedida, a instalada e a pasta dela);
- um nó ou protocolo usado vem de um plugin que não está no arquivo (a linha diz o que declarar);
- um nó ou protocolo usado não vem de nenhum plugin ligado. Isso vale também sem o arquivo.

Numa execução filtrada (`--flow`, `--connector`), o `run` confere só os plugins declarados: um
fluxo de outra parte do workspace não bloqueia a execução. Sem o arquivo, serve qualquer plugin
instalado e ligado, sem conferência de versão. Com `--no-plugins`, nada é conferido, e os nós de plugin falham com
`PLUGIN_UNAVAILABLE`.

### vvpost-plugin-javascript

```js
// nodes tem a saída dos nós anteriores
const items = nodes.Cart.data.items
console.log('itens', items.length)
const res = await http.send({ method: 'GET', url: '{{BASE_URL}}/rates' })
return { total: items.reduce((s, i) => s + i.price, 0) * res.json().brl }
```

No script: `nodes`, `output` (alternativa ao `return`), `console`, `http` (o `ctx.http` do SDK)
e `signal`. O Visual Data Picker escreve a referência como `nodes.Nome.data.campo`. Erros de
sintaxe e exceções apontam a linha do script.

O nó `javascript.request-script` é o script pre ou post de uma requisição
([quick-request.md](quick-request.md#scripts-pre-e-post)): recebe a requisição (`request`), a
resposta (`response`, no post), as variáveis do ambiente e as dos scripts anteriores, e expõe a API
`vv` (`vv.request`, `vv.response`, `vv.variables`, `vv.test`, `vv.expect`). Devolve
`{ request, variables, tests }`; o nó de requisição seguinte lê a requisição alterada com
`fromScript`. É o nó que o Quick Request monta por trás e que **Ver como fluxo** mostra.

### vvpost-plugin-graphql

Campos: `url` (padrão `/graphql`, relativa à baseUrl do conector), `query`, `variables`
(objeto JSON), `operationName`, `headers` (objeto) e `ignoreErrors`. A saída é
`{ data: <corpo { data, errors }>, status, headers }`, então o resultado fica em
`$nodes.User.data.data.user`. Uma resposta com `errors` falha o nó com as mensagens
(`[GRAPHQL_ERRORS] GraphQL: ...`), a menos que `ignoreErrors` esteja marcado.

### vvpost-plugin-grpc

O conector do nó dá o servidor: `grpc://host:porta` (HTTP/2 em texto puro) ou `grpcs://` (TLS,
com o mTLS do conector). Os headers do conector e a auth viram metadata da chamada.

Campos: `service` (`pacote.Serviço`, ou só `Serviço` se o nome for único), `method`, `message`
(a requisição em JSON, no mapeamento do proto3: int64 em texto, bytes em base64, enums pelo
nome; em client streaming, uma lista envia várias mensagens), `proto` (opcional), `metadata`
(objeto) e `emitDefaults`. Sem `.proto`, os tipos vêm do server reflection
(`grpc.reflection.v1`, com volta para `v1alpha`) e ficam guardados por 60 s. Com `.proto`, cole
o arquivo; imports que não são do `google/protobuf` vão colados em sequência, cada um começando
com `syntax`. Os tipos conhecidos (`Timestamp`, `Duration`, `Struct`, `Any`, wrappers,
`FieldMask`) seguem o JSON do proto3.

A saída é `{ data, status, headers }`: `data` é a resposta (uma lista em server streaming),
`headers` tem os headers e trailers, com `grpc-status` e `grpc-message`. Um status diferente
de OK vira o HTTP equivalente (`NOT_FOUND` → 404, `UNAUTHENTICATED` → 401, `UNAVAILABLE` →
503...) com `data: { code, message }`, e falha o nó com `HTTP_STATUS` a menos que ele marque
`ignoreHttpErrors`. O plugin conecta só ao host do conector.

### vvpost-plugin-mkdocs

Exportador `mkdocs` da documentação: o `mkdocs.yml` com a navegação do `vvpost.publish.json` e uma
página Markdown por página, no formato que o Backstage TechDocs gera. Não roda em fluxos; aparece
no **Enviar para…** e no `vvpost docs export`. Guia em [publish.md](publish.md#mkdocs-e-backstage-techdocs).

### vvpost-plugin-kafka

O conector do nó dá o broker de bootstrap: `kafka://host:9092` ou `kafkas://host:9093` (TLS,
com o mTLS do conector). Uma auth basic no conector vira SASL PLAIN ou SCRAM-SHA-256/512, e uma
bearer ou OAuth2 vira OAUTHBEARER (o campo **Mecanismo SASL** escolhe; no automático, basic usa
PLAIN se o broker aceitar). Fala com Kafka 1.0 ou mais novo, sem dependências.

| Operação | Campos | `data` |
| --- | --- | --- |
| Produzir | `topic`, `key`, `value` (texto vai como está, outro JSON serializado), `headers`, `partition`, `acks`, `compression` (`gzip`, `zstd`) | `{ topic, partition, offset, timestamp }` |
| Consumir | `topic`, `from` (as últimas, o início, agora, um horário, um offset), `count` (até 1000), `partition`, `timestamp`, `offset`, `maxWaitMs`, `format` | Lista de `{ topic, partition, offset, timestamp, key, value, headers }` |
| Tópicos | `topic` (vazio lista todos) | `{ clusterId, controller, brokers, topics: [{ name, partitions }] }` |

A chave escolhe a partição como o produtor Java (murmur2). Consumir não entra num consumer
group nem grava offsets: é uma leitura, como um `kafka-console-consumer` sem grupo. Os batches
comprimidos com gzip, snappy, lz4 ou zstd são lidos. O valor sai como JSON quando é JSON, senão
texto (`format` força JSON, texto ou base64). Offsets vão em texto, por serem int64.

O plugin conecta ao host do conector e aos do campo **Brokers**. Se o cluster anuncia brokers
com outros nomes (um cluster de vários nós, ou um serviço gerenciado), escreva-os ali
(`b1.kafka:9092, b2.kafka:9092` ou `*.kafka.example.com:9092`); um broker anunciado fora deles
falha com `POLICY_DENIED`. Conferido contra um Kafka 3.9 (KRaft) com SASL PLAIN e SCRAM e as
quatro compressões; os testes do repositório usam um broker de mentira
([`test/helpers/fake-kafka.ts`](../test/helpers/fake-kafka.ts)) e rodam contra um broker real
com `VVPOST_KAFKA_BROKER=host:porta`.

## Protocolos no Quick Request e nos cenários

Os adapters dos plugins ligados também rodam fora do Flow Studio, pelo mesmo caminho do nó de
plugin: o mesmo processo com sandbox, as mesmas regras de rede, a herança do conector e, com
`permissions.connectorCredentials`, a conexão resolvida em `ctx.connection`.

**Quick Request.** O seletor **Protocolo**, antes do método, oferece HTTP e os adapters dos
plugins ligados (GraphQL, gRPC, Kafka...). A lista é lida quando o seletor vai ser usado (ou
uma aba de plugin aparece), para a abertura do app não carregar o gerenciador de plugins. Num protocolo de plugin, método, URL,
params, headers e body dão lugar aos campos que o adapter declara no manifesto, e o envio usa o
conector e o ambiente do contexto. A saída `{ data, status, headers }` vira a resposta: `data`
em texto vai como está e o resto vira JSON (com `content-type: application/json` se o adapter
não mandou outro), sem `status` é 200, e a resposta diz "pelo adapter <protocolo>" (os logs do
plugin ficam no título). Cancelar é o mesmo botão. Escolher no contexto um endpoint com `plugin`
troca a aba para o protocolo dele, com a config do arquivo; "Gerar cenário de teste" grava o
que mudou nos campos como `overrides.config`. As chamadas de plugin do Quick Request não entram
no histórico.

**Endpoint com plugin.** Um endpoint do conector pode ser chamado por um adapter:

```json
{
  "id": "publicar",
  "name": "Publicar pedido",
  "method": "POST",
  "path": "/pedidos",
  "plugin": {
    "adapter": "kafka",
    "config": { "operation": "produce", "topic": "pedidos", "value": { "id": 1 } },
    "timeoutMs": 10000
  },
  "scenarios": [
    {
      "id": "grande",
      "name": "Pedido grande",
      "overrides": { "config": { "value": { "id": 2, "total": 9999 } } },
      "capture": { "offset": "body.offset" },
      "assertions": [{ "target": "status", "operator": "equals", "expected": 200 }]
    }
  ]
}
```

`method` e `path` ficam como rótulo (na matriz, no Quick Request); `headers`, `query` e `body`
não se aplicam. Nos cenários, `overrides.config` mescla com `plugin.config` campo a campo, e
`null` tira um campo (volta ao padrão do manifesto). As asserções e o `capture` leem a
resposta como no HTTP: `status`, `headers.<nome>` e `body.<caminho>` sobre o `data` do
adapter. Um texto da config com `{{$capture.<nome>}}` recebe o que um cenário de `dependsOn`
capturou; esse valor, como o de `$nodes`, não vira `{{VAR}}` do ambiente se o plugin o mandar
pelo host. `{{VAR}}` do ambiente fica literal na config, como no nó.

O app, o `vvpost run` e o servidor de webhooks rodam esses cenários com os plugins ligados
(o CLI sem eles com `--no-plugins`). Pelo MCP, como os nós de plugin nos fluxos da IA, não: o
cenário volta com `PLUGIN_UNAVAILABLE`, porque o guard da IA não alcança o processo do plugin.

## Escrevendo um plugin

Um plugin é uma pasta com o manifesto e um arquivo JavaScript:

```
acme-greeter/
  vvpost-plugin.json
  index.js
```

### Manifesto (`vvpost-plugin.json`)

Validado pelo schema [`plugin.json`](../packages/schemas/schemas/plugin.json) (`PluginManifest`).

```json
{
  "$schema": "https://vvpost.dev/schemas/v1/plugin.json",
  "id": "acme-greeter",
  "name": "Acme Greeter",
  "version": "1.0.0",
  "author": "Acme",
  "main": "index.js",
  "apiVersion": 1,
  "contributes": {
    "nodes": [
      {
        "type": "acme.greet",
        "title": "Greet",
        "fields": [{ "key": "name", "label": "Nome", "type": "text", "required": true }]
      }
    ],
    "adapters": [
      {
        "protocol": "acme",
        "title": "Acme RPC",
        "fields": [{ "key": "method", "label": "Método", "type": "text", "required": true }]
      }
    ]
  }
}
```

| Campo | Regra |
| --- | --- |
| `id` | minúsculas e hífens; é o nome da pasta instalada |
| `version` | semver (`1.2.0`, `1.2.0-beta.1`) |
| `main` | `.js`/`.cjs` (CommonJS) ou `.mjs` (ES module), dentro da pasta do plugin |
| `apiVersion` | `1` nesta versão do VVPost |
| `permissions.network` | Hosts a que o plugin conecta por conta própria ([Rede declarada](#rede-declarada)); sem o campo, nenhum |
| `permissions.connectorCredentials` | `true` entrega `ctx.connection` aos adapters; só com `network` restrito a `connector` e `config:<campo>` |
| `contributes.nodes[].type` | `<namespace>.<nome>` (ex.: `acme.greet`) |
| `contributes.adapters[].protocol` | ex.: `grpc`; `http` e `https` são reservados |
| `contributes.diagrams` | ícones e blocos do editor de diagramas ([abaixo](#ícones-e-blocos-do-editor-de-diagramas)) |
| `contributes.exporters[].id` | exportador da documentação, o `provider` de um destino do `vvpost.publish.json` ([abaixo](#exportadores-da-documentação)); `html` e `confluence-cloud` são reservados |
| `contributes.publishers[]` | publicador remoto da documentação, com `hosts` e `auth` ([abaixo](#publicadores-da-documentação)); o `id` não repete o de um exportador |
| `fields[].type` | `text`, `textarea`, `code`, `json`, `number`, `boolean`, `select` (com `options`) |
| `fields[].templates` | `false` entrega o texto sem resolver `{{ $nodes... }}` |
| `fields[].language` | só para `code`; `javascript` com `templates: false` faz o Data Picker escrever `nodes.X` |

### Ícones e blocos do editor de diagramas

`contributes.diagrams` estende a paleta do [editor de diagramas](documentation.md#diagramas) da
documentação com bibliotecas de ícones e blocos. São só dados: nada do plugin roda para isso
(o `main` continua obrigatório no manifesto, e pode exportar `{}`).

```json
{
  "id": "acme-nuvem",
  "name": "Acme Nuvem",
  "version": "1.0.0",
  "main": "index.js",
  "apiVersion": 1,
  "contributes": {
    "diagrams": {
      "iconPacks": [{ "prefix": "acme", "title": "Acme Nuvem", "file": "icons/acme.json" }],
      "blocks": [
        {
          "title": "Função",
          "category": "Acme",
          "code": "  fn@{ icon: \"acme:funcao\", label: \"Função\", pos: \"b\" }",
          "icon": "acme:funcao"
        }
      ]
    }
  }
}
```

| Campo | Regra |
| --- | --- |
| `iconPacks[].prefix` | minúsculas e hífens; único entre os plugins ligados (dois plugins com o mesmo prefixo ficam em conflito); `vv` é do VVPost |
| `iconPacks[].file` | JSON no formato do [Iconify](https://iconify.design/docs/types/iconify-json.html) (`icons`, `width`, `height`), dentro da pasta do plugin; até 4 MB e 10 000 ícones |
| `blocks[].category` | grupo da paleta (ex.: `AWS`, `Kafka`) |
| `blocks[].code` | trecho Mermaid inserido no cursor ou onde o bloco é arrastado |
| `blocks[].icon` | ícone mostrado na paleta, `prefixo:nome` |

Os ícones valem em `architecture-beta` (`service fn(acme:funcao)[Função]`) e em nós de fluxograma
(`fn@{ icon: "acme:funcao" }`). O SVG de cada ícone passa pelo DOMPurify antes de entrar no
diagrama: `<script>` e atributos `on*` são removidos.

### Código

O arquivo de `main` exporta as implementações, com as mesmas chaves do manifesto:

```js
// @ts-check
/** @type {import('@vvpost/plugin-sdk').PluginModule} */
module.exports = {
  nodes: {
    'acme.greet': {
      run(ctx) {
        ctx.log('saudando', ctx.config.name)
        return `Olá, ${ctx.config.name}!`
      }
    }
  },
  adapters: {
    acme: {
      async send(ctx) {
        const res = await ctx.http.send({ method: 'POST', url: '/rpc', body: { method: ctx.config.method } })
        return { data: res.json(), status: res.status, headers: res.headers }
      }
    }
  }
}
```

Num `.mjs`, use `export default { nodes, adapters }`. O plugin não precisa de nenhum pacote
do VVPost em runtime; o [`@vvpost/plugin-sdk`](../packages/plugin-sdk) tem os tipos
(`PluginModule`, `NodeContext`, `AdapterContext`, `HttpResponse`...), o `definePlugin` e o
`PluginError`, que você pode empacotar junto ou usar só para os tipos via JSDoc.
Dependências do npm vão na pasta do plugin: `node_modules` é copiado na instalação (até 5000
arquivos e 100 MB por plugin).

### O `ctx`

| Campo | O que é |
| --- | --- |
| `config` | Campos do manifesto com defaults aplicados e `{{ $nodes... }}` resolvido |
| `nodes` | Saída dos nós anteriores, como em `$nodes` (uma cópia) |
| `node` | `{ id, name }` do nó que está rodando |
| `timeoutMs` | Tempo desta chamada |
| `signal` | `AbortSignal` abortado no cancelamento ou no timeout: pare o trabalho quando ele disparar |
| `log(...)` | Logs do nó (também `console.*`) |
| `http.send(req)` | Requisição pelo dispatcher do VVPost: `{ method, url, headers, body, timeoutMs }`. `body` em objeto vira JSON. Resolve com `{ status, statusText, headers, body, truncated, durationMs, json() }`; erros de rede rejeitam com um `code` (`TIMEOUT`, `CONNECTION_REFUSED`, `AUTH_FAILED`, `POLICY_DENIED`...) |
| `connector` | Só em adapters: o id do conector do nó. Uma url relativa usa a baseUrl dele |
| `connection` | Só em adapters de plugins com `permissions.connectorCredentials`: `{ url, headers, query, auth?, tls? }` do conector do nó, com as variáveis do ambiente resolvidas (`tls` tem `ca`, `cert`, `key` em PEM e `pfx` em base64) |

`run` (nó) devolve qualquer valor serializável em JSON, que vira `$nodes.<nome>.data`.
`send` (adapter) devolve `{ data, status?, headers? }`. Lançar um erro falha o nó com
`PLUGIN_ERROR`; um `code` no erro aparece na mensagem.

### Exportadores da documentação

Um plugin acrescenta um formato ao **Enviar para…** e ao `vvpost docs export` com
`contributes.exporters`:

```json
"contributes": {
  "exporters": [{ "id": "docusaurus", "title": "Docusaurus", "description": "docs/*.md e sidebars.js" }]
}
```

O `id` é o `provider` do destino no `vvpost.publish.json` (minúsculas, dígitos e hífens; `html` e
`confluence-cloud` são do VVPost). O código exporta `exporters[id].export(ctx)`:

```js
/** @type {import('@vvpost/plugin-sdk').PluginModule} */
module.exports = {
  exporters: {
    docusaurus: {
      export(ctx) {
        const files = []
        const walk = (nodes) => nodes.forEach((n) => {
          if (n.page) files.push({ path: `docs/${n.key.replace(/[^a-z0-9]+/gi, '-')}.md`, page: n.key, text: `# ${n.title}\n\n${n.page.markdown}` })
          walk(n.children)
        })
        walk(ctx.bundle.nodes)
        return { files }
      }
    }
  }
}
```

| Campo do `ctx` | O que é |
| --- | --- |
| `bundle` | A documentação montada e sem segredos: `nodes` (a árvore da estrutura, cada página com `blocks`, a árvore neutra com títulos, tabelas, código, alertas, diagramas e links entre páginas, e `markdown`), `assets` (imagens e diagramas, com os bytes em `base64`), `meta` (título, versão, cor e logo do modelo), `api.endpoints` e `site` |
| `changelog` | O histórico das exportações nesta pasta, com a entrada desta no topo |
| `previous` | O `vvpost-site.json` da exportação anterior, ou `null` |
| `timeoutMs`, `signal`, `log(...)` | Como nos nós (o tempo de uma exportação é de 3 minutos) |

`export` devolve `{ files: [{ path, text | base64, page? }] }`. O VVPost confere cada caminho
(relativo, dentro da pasta de saída, sem `..` e sem o `vvpost-site.json`) e grava; o processo do
plugin continua sem escrita em disco. `page` liga o arquivo a uma página: no app, a página que
mudou só é regravada com a confirmação da pessoa, e o diff do plano mostra o texto do arquivo. O
exportador não tem `ctx.http`. O oficial [vvpost-plugin-mkdocs](../plugins/vvpost-plugin-mkdocs/index.js)
é um exemplo completo.

### Publicadores da documentação

Um publicador leva a documentação a um destino remoto, com a conta da pessoa. O manifesto diz com
quem ele fala e como a credencial entra:

```json
"contributes": {
  "publishers": [
    {
      "id": "wiki",
      "title": "Wiki da empresa",
      "hosts": ["wiki.empresa.com"],
      "auth": { "type": "bearer", "label": "Token de integração", "help": "https://wiki.empresa.com/tokens" }
    }
  ]
}
```

| Campo | O que é |
| --- | --- |
| `hosts` | Os únicos hosts a que o `ctx.http` do publicador chega (`api.x.com`, `*.x.com`, com porta se não for a padrão), só por HTTPS; HTTP só para `127.0.0.1`, `localhost` e `[::1]`. O Extensions Hub mostra a lista antes de instalar |
| `auth.type` | `bearer` (`Authorization: Bearer`), `basic` (a pessoa cola `usuário:token`) ou `header` (o token no header de `auth.header`) |
| `auth.label`, `auth.help` | O que a pessoa cola no **Enviar para…** e onde aprender a gerar (HTTPS) |

O código exporta `publishers[id]` com `plan(ctx)` e `publish(ctx)`, e `session(ctx)` opcional:

```js
/** @type {import('@vvpost/plugin-sdk').PluginModule} */
module.exports = {
  publishers: {
    wiki: {
      async session(ctx) {
        const r = await ctx.http.send({ method: 'GET', url: 'https://wiki.empresa.com/api/me' })
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
        return { account: r.json().name, destination: ctx.target.destination }
      },
      async plan(ctx) {
        // Só lê: compara ctx.bundle (as páginas) com o destino e ctx.bundle.published (o que já foi).
        return { destination: { label: ctx.target.destination }, items: [/* { key, kind, title, path, action } */] }
      },
      async publish(ctx) {
        // Cria o que é create; update, conflict e orphan só com a chave em ctx.approval.
        return { items: [/* { key, outcome, id, version, url } */] }
      }
    }
  }
}
```

| Campo do `ctx` | O que é |
| --- | --- |
| `target` | O destino do `vvpost.publish.json`: `id`, `name`, `provider`, `destination` e `diagrams` |
| `http` | Como nos nós, mas só para os `hosts`, já com a credencial da pessoa (o plugin não a vê, e o `Authorization` ou `Cookie` que ele puser é trocado). Redirecionamentos não são seguidos |
| `bundle` | Em `plan` e `publish`: o pacote dos exportadores, mais `published` (o que o destino já tem, pela chave) |
| `plan`, `approval` | Em `publish`: o plano que a pessoa viu e o que ela confirmou (`update`, `conflicts`, `archive`) |
| `timeoutMs`, `signal`, `log(...)` | Como nos nós (30 s na sessão, 3 min no plano, 10 min na publicação; até 5.000 requisições por chamada) |

`session` lançar diz que a credencial não serve: no **Entrar**, ela nem é guardada. O VVPost confere
o plano e o resultado campo a campo; uma página que o plugin diz ter mudado sem a confirmação vira
falha e não vai para o `vvpost.publish.json` ([Publicadores de plugins](publish.md#publicadores-de-plugins)).

### Ciclo de vida do processo

O processo sobe na primeira chamada a qualquer contribuição do plugin, carrega o `main` uma vez
e atende as chamadas em paralelo (nós independentes do fluxo rodam juntos). Depois de 60 s
sem chamadas ele para. Estado global do módulo vive enquanto o processo vive, então não conte
com ele entre execuções. O processo só lê a pasta do plugin: o que ele precisar em runtime
(dependências, dados) vai dentro dela, e um `node_modules` com links para fora da pasta não
carrega. Um `main` que lança ao carregar deixa o plugin com o erro no
Extensions Hub e os nós com `PLUGIN_UNAVAILABLE`.

### Publicar um plugin

O CLI tem as ferramentas de quem publica (`vvpost plugin`, sem precisar de workspace):

```sh
vvpost plugin keygen --out acme.key          # uma vez; guarde a chave fora do repositório
vvpost plugin pack ./acme-greeter --key acme.key
# Pacote: acme-greeter-1.2.0.zip (3 arquivos, 2 KB)
# SHA-256: 5f0c...
# Assinatura: 1a2b:3c4d:...
# Entrada em plugins[].versions do vvpost-registry.json: { "version": "1.2.0", "url": ..., "sha256": ..., "publicKey": ... }
vvpost plugin verify acme-greeter-1.2.0.zip  # 0 se a assinatura for válida
```

`pack` assina (com `--key`), grava `vvpost-plugin.sig.json` na pasta e gera o `.zip` com todos os
arquivos menos `.git`. Distribua o `.zip` direto ou publique a entrada num registro. `sign`
só assina a pasta. Assine depois da última mudança: qualquer arquivo mudado invalida a
assinatura.

### Testar o plugin

Instale a pasta pelo Extensions Hub, crie um fluxo com o nó e rode. Para mudar o código,
instale de novo (substitui a versão). Os testes do VVPost mostram como exercitar um plugin sem
a interface: [`test/plugins.test.ts`](../test/plugins.test.ts) usa o `PluginManager` com uma
pasta temporária de plugins.
