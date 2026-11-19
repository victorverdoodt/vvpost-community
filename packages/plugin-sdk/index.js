'use strict'

/**
 * Plugin SDK do VVPost (apiVersion 1). O host não precisa deste pacote em runtime:
 * definePlugin só devolve o objeto (serve para o editor checar os tipos), e
 * PluginError é um Error com `code`. Empacote o plugin com ele ou copie as duas
 * funções; o VVPost lê só o que o arquivo de main exporta.
 */
function definePlugin(plugin) {
  return plugin
}

class PluginError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'PluginError'
    if (code !== undefined) this.code = code
  }
}

module.exports = { definePlugin, PluginError, API_VERSION: 1 }
