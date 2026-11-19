// "Enviar para…": a documentação montada para um destino externo (Confluence, Notion...). Chunk
// carregado só quando a pessoa abre o diálogo: nada daqui pesa no cold start.
export { blocksToText, markdownToBlocks, plain, type BlockResolvers } from './blocks'
export { buildPublishBundle, diagramFormat, pendingDiagrams, svgFile, type BuiltBundle } from './bundle'
export { applyResult, loadPublishConfig, PUBLISH_CONFIG_FILE, recordPublished, starterPublishConfig, type LoadedPublishConfig } from './config'
export { pluginPublisher, publisherHostAllowed, type PluginPublisherDeps, type PluginPublisherInfo, type PublisherCredentials } from './plugin'
export type * from './types'
