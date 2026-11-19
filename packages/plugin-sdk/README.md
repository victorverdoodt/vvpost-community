# @vvpost/plugin-sdk

Tipos da API de plugins do VVPost (`apiVersion: 1`), mais `definePlugin` e `PluginError`.
O guia completo, com o manifesto, o `ctx` e o **modelo de confiança**, está em
[docs/plugins.md](../../docs/plugins.md).

O host não fornece este pacote em runtime: o plugin pode empacotá-lo junto ou usá-lo só para
os tipos via JSDoc, como os plugins oficiais em [`plugins/`](../../plugins):

```js
// @ts-check
/** @type {import('@vvpost/plugin-sdk').PluginModule} */
module.exports = {
  nodes: {
    'acme.greet': { run: (ctx) => `Olá, ${ctx.config.name}!` }
  }
}
```

| Export | O que é |
| --- | --- |
| `PluginModule` | O que o `main` do plugin exporta: `{ nodes, adapters }` |
| `NodeContext`, `AdapterContext` | O `ctx` de `run` e de `send` |
| `HttpRequest`, `HttpResponse`, `HttpError` | `ctx.http.send` |
| `AdapterResult` | `{ data, status?, headers? }`, o retorno de um adapter |
| `definePlugin(plugin)` | Devolve o próprio objeto (serve para checar os tipos) |
| `PluginError(message, code?)` | `Error` com `code`, mostrado no nó como `[code] message` |

O schema do manifesto (`vvpost-plugin.json`) é o `plugin.json` de
[`@vvpost/schemas`](../schemas/schemas/plugin.json).
