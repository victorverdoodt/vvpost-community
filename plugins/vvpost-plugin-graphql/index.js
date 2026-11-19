// @ts-check
'use strict'

/**
 * Plugin oficial vvpost-plugin-graphql: adapter de protocolo "graphql" (GraphQL over
 * HTTP, POST com JSON). A requisição sai por ctx.http, ou seja, pelo dispatcher do
 * VVPost: com um conector no nó, a baseUrl, os headers, a auth (o plugin nunca vê o
 * token) e o mTLS herdados valem, e {{VAR}} do ambiente é resolvido no host.
 */

class GraphQLError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/** @param {unknown} value */
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * @typedef {{ url: string, query: string, variables?: Record<string, unknown>, operationName?: string,
 *   headers?: Record<string, string>, ignoreErrors?: boolean }} GraphQLConfig
 */

/** @type {import('@vvpost/plugin-sdk').PluginModule} */
module.exports = {
  adapters: {
    graphql: {
      /** @param {import('@vvpost/plugin-sdk').AdapterContext<GraphQLConfig>} ctx */
      async send(ctx) {
        const { url, query, variables, operationName, headers = {}, ignoreErrors = false } = ctx.config
        if (variables !== undefined && !isObject(variables)) throw new GraphQLError('as variáveis precisam ser um objeto JSON', 'INVALID_VARIABLES')
        if (!isObject(headers) || Object.values(headers).some((v) => typeof v !== 'string')) {
          throw new GraphQLError('headers precisa ser um objeto { "Nome": "valor" } com valores em texto', 'INVALID_HEADERS')
        }
        const res = await ctx.http.send({
          method: 'POST',
          url,
          headers: {
            accept: 'application/graphql-response+json, application/json;q=0.9',
            'content-type': 'application/json',
            ...headers
          },
          body: JSON.stringify({ query, ...(variables && { variables }), ...(operationName && { operationName }) })
        })
        /** @type {any} */
        let body
        try {
          body = res.json()
        } catch {
          // Um 4xx/5xx sem JSON segue para o host, que falha o nó com o status (ou deixa seguir com ignoreHttpErrors).
          if (res.status >= 400) return { data: res.body, status: res.status, headers: res.headers }
          throw new GraphQLError(`a resposta não é JSON (HTTP ${res.status}): ${res.body.slice(0, 200)}`, 'INVALID_RESPONSE')
        }
        const errors = isObject(body) && Array.isArray(body.errors) ? body.errors : []
        if (errors.length && !ignoreErrors) {
          const messages = errors.slice(0, 3).map((/** @type {unknown} */ e) => (isObject(e) && typeof (/** @type {any} */ (e)).message === 'string' ? (/** @type {any} */ (e)).message : JSON.stringify(e)))
          const more = errors.length > 3 ? ` (+${errors.length - 3})` : ''
          throw new GraphQLError(`GraphQL: ${messages.join('; ')}${more}`, 'GRAPHQL_ERRORS')
        }
        ctx.log(`HTTP ${res.status} em ${Math.round(res.durationMs)} ms${errors.length ? `, ${errors.length} erro(s)` : ''}`)
        return { data: body, status: res.status, headers: res.headers }
      }
    }
  }
}
