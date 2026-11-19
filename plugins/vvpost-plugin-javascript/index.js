// @ts-check
'use strict'
const vm = require('node:vm')
const { createApi } = require('./lib/request-script')

/**
 * Plugin oficial vvpost-plugin-javascript: o nó javascript.script roda o código do
 * usuário num contexto do node:vm dentro do Worker Thread do plugin. O contexto só
 * tem `nodes`, `output`, `console`, `http` e `signal` (sem require, process ou
 * fetch), mas o node:vm não é uma fronteira de segurança: rode só scripts em que
 * você confia, como no nó Python (docs/plugins.md).
 */

/**
 * Linha do erro no script do usuário, quando o stack a mostra.
 * @param {any} err
 * @param {string} filename
 */
function where(err, filename) {
  const stack = err && typeof err.stack === 'string' ? err.stack : ''
  const match = stack.match(new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+)'))
  return match ? ` (linha ${match[1]})` : ''
}

/**
 * Roda o código do usuário num contexto só com o que `globals` der, mais console, http e signal.
 * @param {import('@vvpost/plugin-sdk').NodeContext<any>} ctx
 * @param {string} code
 * @param {Record<string, unknown>} globals
 */
async function runCode(ctx, code, globals) {
  const filename = `${ctx.node.name}.js`
  /** @type {Record<string, any>} */
  const sandbox = {
    ...globals,
    console: { log: ctx.log, info: ctx.log, warn: ctx.log, error: ctx.log, debug: ctx.log },
    http: ctx.http,
    signal: ctx.signal
  }
  const context = vm.createContext(sandbox, {
    name: `nó ${ctx.node.name}`,
    codeGeneration: { strings: false, wasm: false }
  })
  let script
  try {
    // A primeira linha do wrapper fica fora da contagem: o erro aponta a linha do script.
    script = new vm.Script(`(async () => {\n${code}\n})()`, { filename, lineOffset: -1 })
  } catch (/** @type {any} */ err) {
    throw new Error(`erro de sintaxe: ${err.message}${where(err, filename)}`)
  }
  try {
    // timeout cobre a parte síncrona (um laço infinito); o resto é o tempo do nó, no host.
    return { result: await script.runInContext(context, { timeout: ctx.timeoutMs }), sandbox }
  } catch (/** @type {any} */ err) {
    throw new Error(`${err && err.message ? err.message : String(err)}${where(err, filename)}`)
  }
}

/** @type {import('@vvpost/plugin-sdk').PluginModule} */
module.exports = {
  nodes: {
    'javascript.script': {
      /** @param {import('@vvpost/plugin-sdk').NodeContext<{ code: string }>} ctx */
      async run(ctx) {
        const { result, sandbox } = await runCode(ctx, ctx.config.code, { nodes: ctx.nodes, output: undefined })
        return result === undefined ? sandbox.output : result
      }
    },
    // Script de uma requisição (fase 13): pre antes do nó de requisição, post depois dele.
    'javascript.request-script': {
      /** @param {import('@vvpost/plugin-sdk').NodeContext<{ code: string, phase: 'pre' | 'post', request?: any, response?: any, environment?: Record<string, string>, variables?: Record<string, string> }>} ctx */
      async run(ctx) {
        const api = createApi(ctx.config)
        await runCode(ctx, ctx.config.code, { vv: api.vv, nodes: ctx.nodes })
        return api.result()
      }
    }
  }
}
