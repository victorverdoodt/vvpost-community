# Exemplos de resposta e mock server

Cada endpoint pode guardar respostas de exemplo. Elas documentam o endpoint e são o que o mock
server local devolve, para um front-end ou um teste andar antes de a API existir (ou sem rede).

## Exemplos no endpoint

Ficam em `endpoints[].examples` do arquivo do conector:

```json
{
  "id": "get_user",
  "name": "Buscar usuário",
  "method": "GET",
  "path": "/users/{id}",
  "examples": [
    { "id": "ok", "name": "Achou", "status": 200, "body": { "id": "{{$path.id}}", "nome": "Ana" } },
    { "id": "sumiu", "name": "Não achou", "status": 404, "body": { "error": "NOT_FOUND" }, "delayMs": 300 }
  ]
}
```

- `status` (100 a 599), `headers` opcionais e `body` em texto ou JSON. Sem `Content-Type`, o mock
  usa `application/json` para JSON e `text/plain` para texto.
- No corpo, `{{$path.<nome>}}` e `{{$query.<nome>}}` trazem o que veio na requisição, e as
  variáveis dinâmicas (`{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`)
  mudam a cada resposta. Variáveis de ambiente não entram: o mock não lê segredos.
- `delayMs` atrasa a resposta, para simular latência.
- `schema` (opcional) é o JSON Schema do corpo dessa resposta. Com ele, o exemplo deixa de ser só
  ilustração e passa a ser conferido. Veja [Exemplo conferido pelo schema](#exemplo-conferido-pelo-schema).

Três jeitos de criar:

- No **Quick Request**, com a requisição ligada a um endpoint, **Salvar a resposta como exemplo do
  endpoint** (menu da requisição ou `Ctrl+K`) guarda a última resposta: status, `Content-Type` e
  corpo. Os outros headers ficam de fora, porque `Set-Cookie` e afins carregam sessão. Resposta
  cortada pelo limite de tamanho ou binária não vira exemplo.
- No **Catálogo**, o editor do conector tem **Exemplos de resposta (mock server)** em cada
  endpoint, em JSON.
- O [importador de OpenAPI](import-export.md) traz as respostas documentadas: cada exemplo nomeado
  da resposta JSON, ou um gerado pelo schema, com o status e o schema dela (até 8 por operação). A
  reimportação da spec não mexe nos exemplos que o projeto já tem.

A IA pelo MCP edita com as operações `upsertExample` e `deleteExample` de `edit_project`.

Num projeto em fluxos, os exemplos ficam em `examples` do fluxo de requisição do endpoint, com o
mesmo formato.

## Exemplo conferido pelo schema

Um exemplo com `schema` é conferido nos dois sentidos.

- **O exemplo segue o schema.** O `vvpost validate` reprova o exemplo cujo corpo sai do `schema` dele,
  e o CI fica vermelho até alguém corrigir um ou outro. Um corpo em texto que é JSON vale como o JSON.
  `{{$path.id}}` e as outras variáveis que o mock troca não contam como erro de tipo. No app, o
  Catálogo marca o exemplo fora do schema. Uma gravação pelo app ou pelo MCP que deixa um exemplo
  fora do schema avisa na hora.
- **A API segue o exemplo.** A asserção `matchesExample` de um cenário confere o corpo da resposta
  real com o `schema` do exemplo do mesmo status. Assim, documentação e API não se separam sem o
  teste perceber ([tests.md](tests.md#asserções)).

```json
{
  "id": "ok",
  "name": "Achou",
  "status": 200,
  "body": { "id": "{{$path.id}}", "nome": "Ana" },
  "schema": { "type": "object", "required": ["id", "nome"], "properties": { "nome": { "type": "string" } } }
}
```

O importador de OpenAPI preenche o `schema` de cada exemplo com o schema da resposta na spec.
Exemplo da spec que não segue o schema dela entra assim mesmo, e o resumo do import lista a
operação. A exportação para OpenAPI faz o caminho de volta: o `schema` vira o schema da resposta.

## Mock server

No app, **Mock** na barra de status liga o servidor em `http://127.0.0.1:4490` (troque com
`VVPOST_MOCK_PORT`); o número depois da porta conta as requisições atendidas. No terminal,
`vvpost mock` faz o mesmo até o `Ctrl+C` e escreve uma linha por requisição
([cli.md](cli.md#comandos)).

- O caminho é o `basePath` do conector (com a herança) mais o `path` do endpoint: o endpoint
  acima, num conector com `basePath` `/api/v1`, responde em `GET /api/v1/users/42`. A `baseUrl`
  não entra.
- Entre rotas que casam, vence a com menos parâmetros (`/users/me` antes de `/users/{id}`). O
  header `X-VVPost-Connector: <id>` escolhe o conector quando dois servem o mesmo caminho.
- Sem pedido, vem o primeiro exemplo 2xx (ou o primeiro de todos). Para outro:
  `?__example=<id ou nome>`, `?__status=<código>`, os headers `X-VVPost-Example` e
  `X-VVPost-Status`, ou `Prefer: code=404` e `Prefer: example=sumiu`.
- Sem exemplo, o endpoint responde `501`; um exemplo pedido que não existe, `404` com a lista dos
  que existem; um caminho conhecido com outro método, `405`; um caminho fora do workspace, `404`.
  Toda resposta tem `X-VVPost-Mock: <conector>/<endpoint>#<exemplo>`.
- CORS liberado (inclusive o preflight), para um front-end local chamar direto. Só aceita conexões
  de `127.0.0.1`.
- O workspace é relido a cada requisição: um exemplo salvo agora já responde, sem reiniciar.
