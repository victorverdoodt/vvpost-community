# Servidor local de webhooks

O VVPost tem um servidor HTTP local (Fastify, em `127.0.0.1:4480`) para depurar integrações
assíncronas de ponta a ponta: um sistema externo manda o webhook, o VVPost mostra o evento como
chegou, responde como você configurou e, se quiser, dispara um fluxo ou cenários de teste. Um nó
**Webhook** no Flow Studio espera por esses eventos, então um fluxo pode criar um pedido e esperar o
callback do pagamento.

## Ligar

| Onde | Como |
| --- | --- |
| App | **Webhooks** na barra de status, ou o painel **Webhooks** (`Ctrl+0`). Liga sozinho quando um fluxo com nó webhook roda. |
| Terminal | `vvpost webhooks` (até o `Ctrl+C`), ou `vvpost run`, que liga o servidor só se um fluxo do lote tem nó webhook. |
| MCP | `node out/main/mcp.js --webhooks`: a IA lê os eventos e os fluxos com nó webhook esperam por eles. |

A porta vem de `port` em `.vvpost/webhooks.json`, de `VVPOST_WEBHOOK_PORT` ou de `--port` (CLI) e
`--webhook-port` (MCP). Os eventos ficam só em memória (os últimos 200) e somem quando o servidor
desliga.

Sem configuração nenhuma, o servidor aceita qualquer método em qualquer caminho e responde
`200 {"received":true,"id":N}`:

```bash
curl -X POST http://127.0.0.1:4480/pedidos/123 -H 'content-type: application/json' -d '{"status":"paid"}'
```

## Configurar hooks

`.vvpost/webhooks.json` (schema `https://vvpost.dev/schemas/v1/webhooks.json`) entra no Git como o
resto do workspace. Nenhum valor de segredo vai nele.

```json
{
  "$schema": "https://vvpost.dev/schemas/v1/webhooks.json",
  "environment": "dev",
  "allowHosts": ["*.ngrok-free.app"],
  "hooks": [
    {
      "id": "github",
      "path": "/github",
      "methods": ["POST"],
      "signature": { "header": "X-Hub-Signature-256", "secret": "{{GITHUB_WEBHOOK_SECRET}}", "prefix": "sha256=" },
      "trigger": { "connector": "repos", "scenarios": ["status"] }
    },
    {
      "id": "pagamentos",
      "path": "/pagamentos/*",
      "response": { "status": 202, "body": { "ok": true }, "delayMs": 200 },
      "trigger": { "flow": "flow.conciliar" }
    }
  ]
}
```

| Campo | O que faz |
| --- | --- |
| `path` | Caminho exato (a barra do fim não conta) ou terminado em `/*`. Com vários que casam, atende o mais específico. |
| `methods` | Métodos aceitos; os outros recebem `405` com `Allow`. |
| `response` | Status, headers, corpo (JSON ou texto) e `delayMs` (até 30 s) da resposta. |
| `signature` | HMAC (`sha256`, `sha1` ou `sha512`, em `hex` ou `base64`, com `prefix` opcional) do corpo cru. `secret` é sempre uma referência `{{VAR}}` a uma variável do ambiente; o valor fica no vault. Assinatura inválida ou ausente: `401`; variável sem valor: `500`. |
| `trigger` | `flow` roda um fluxo; `connector` roda os cenários do conector (ou só os de `scenarios`, por `"<endpoint>"` ou `"<endpoint>/<cenário>"`). `environment` escolhe o ambiente; num [ambiente protegido](security-model.md#ambientes-protegidos) o disparo não roda. |
| `environment` (raiz) | Ambiente das assinaturas e dos disparos; sem ele, o primeiro do workspace. |
| `allowHosts` | Hosts aceitos além de `localhost` e `127.0.0.1`, com `*` (para túneis como ngrok ou cloudflared). |
| `maxEvents`, `maxBodyKB` | Eventos guardados (200) e tamanho máximo do corpo (1024 KB; acima disso, `413`). |

## Inspecionar

O painel **Webhooks** lista os eventos ao vivo, com filtro por hook e busca. Cada evento mostra o
corpo com os visualizadores do Response Viewer, os headers e a query como chegaram, a assinatura, a
resposta dada e o disparo, com link para a execução no Histórico. Do menu de contexto ou do
inspector dá para copiar a URL ou um cURL do evento e **Reenviar** o evento ao servidor (útil depois
de corrigir o fluxo); o reenvio chega com o header `x-vvpost-replay-of`.

No terminal, `vvpost webhooks` escreve uma linha por evento e por disparo; `--json -` escreve um
objeto JSON por linha, sem headers nem corpo. Pelo MCP, `list_webhook_events` e `get_webhook_event`
devolvem os mesmos dados, com credenciais mascaradas.

## Nó webhook

No Flow Studio, **Webhook** espera um evento antes de seguir:

```json
{
  "id": "callback",
  "name": "Callback",
  "type": "webhook",
  "webhook": {
    "path": "/pagamentos/{{ $nodes.CriarPedido.data.id }}",
    "method": "POST",
    "until": { "target": "$nodes.Callback.data.body.status", "operator": "equals", "expected": "paid" },
    "timeoutMs": 120000
  }
}
```

`hook`, `path`, `method` e `until` filtram o evento (todos opcionais); `timeoutMs` é o tempo de
espera (60 s). O nó conta só eventos que chegam depois que o fluxo começou, menos num fluxo
disparado por um hook, em que o evento que disparou já atende. A saída fica em
`$nodes.<nome>.data`: `id`, `receivedAt`, `method`, `path`, `query`, `headers` (em minúsculas),
`body` (JSON e formulário já lidos, binário em base64) e `hook`. Sem servidor, o nó falha com
`WEBHOOK_UNAVAILABLE`; sem evento a tempo, com `WEBHOOK_TIMEOUT`.

## Segurança

- **Só local.** O servidor escuta em `127.0.0.1`. Pedido com header `Origin` (uma página aberta no
  navegador) e `Host` fora de `localhost`, `127.0.0.1` e `allowHosts` (DNS rebinding) recebem `403`
  e ficam no painel como recusados.
- **Disparos com limite.** Um hook dispara sem um humano conferindo, então vale a política de
  disparo sem humano (60 requisições por minuto, 4 simultâneas, timeout até 60 s), no máximo 2
  disparos ao mesmo tempo e 20 na fila. Fluxo com código não revisado, ou conector com auth ou
  destino alterados pela IA, não dispara até a revisão (como no MCP).
- **Segredos.** A chave da assinatura é lida do vault só para conferir e nunca entra no evento,
  nas respostas nem nas mensagens. O que sai para a IA e para o terminal passa pelo Secret
  Sanitizer.
