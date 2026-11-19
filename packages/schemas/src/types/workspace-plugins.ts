/* Arquivo gerado por scripts/generate-types.mjs. Não edite à mão: altere o schema e rode npm run generate. */

/**
 * vvpost.plugins.json, na raiz do workspace: os plugins que os fluxos e endpoints do workspace usam, com a versão aceita de cada um. O vvpost run e o vvpost validate recusam o workspace quando um plugin declarado falta, está desligado ou tem outra versão, e quando um nó ou protocolo de plugin usado vem de um plugin que não está declarado.
 */
export interface WorkspacePlugins {
  $schema?: string
  /**
   * Id do plugin (o id do vvpost-plugin.json dele) para a versão aceita: exata (1.2.0), compatível (^1.2.0: mesma maior, a partir dela; ~1.2.0: mesma menor), mínima (>=1.2.0) ou qualquer (*).
   */
  plugins: {
    [k: string]: string
  }
}
