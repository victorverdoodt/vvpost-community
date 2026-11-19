export type * from './types/connector.ts'
export type * from './types/environment.ts'
export type * from './types/secrets-engine.ts'
export type * from './types/flow.ts'
export type * from './types/plugin.ts'
export type * from './types/bundle.ts'
export type * from './types/webhooks.ts'
export type * from './types/privacy.ts'
export type * from './types/project.ts'
export type * from './types/workspace-plugins.ts'
export type * from './types/docs.ts'
export type * from './types/publish.ts'
export {
  validateConnector,
  validateEnvironment,
  validateSecretsEngineConfig,
  validateFlow,
  validatePluginManifest,
  validateBundle,
  validateWebhooksConfig,
  validatePrivacyConfig,
  validateDocsConfig,
  validatePublishConfig,
  validateProject,
  validateWorkspacePlugins,
  validateJsonSchema,
  type ValidationIssue,
  type ValidationResult
} from './validate.ts'
export {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  checkSchemaVersion,
  schemaUrl,
  type SchemaKind,
  type SchemaMigration,
  type SchemaVersionCheck
} from './versioning.ts'

/** Valor commitado no lugar de toda variável com isSecret: true. */
export const REQUIRED_SECRET = '__REQUIRED_SECRET__'

/** URLs canônicas ($id) dos schemas v1, para o campo "$schema" dos arquivos do workspace. */
export const SchemaId = {
  Connector: 'https://vvpost.dev/schemas/v1/connector.json',
  Environment: 'https://vvpost.dev/schemas/v1/environment.json',
  SecretsEngine: 'https://vvpost.dev/schemas/v1/secrets-engine.json',
  Flow: 'https://vvpost.dev/schemas/v1/flow.json',
  Plugin: 'https://vvpost.dev/schemas/v1/plugin.json',
  Bundle: 'https://vvpost.dev/schemas/v1/bundle.json',
  Webhooks: 'https://vvpost.dev/schemas/v1/webhooks.json',
  Privacy: 'https://vvpost.dev/schemas/v1/privacy.json',
  Docs: 'https://vvpost.dev/schemas/v1/docs.json',
  Publish: 'https://vvpost.dev/schemas/v1/publish.json',
  Project: 'https://vvpost.dev/schemas/v1/project.json',
  WorkspacePlugins: 'https://vvpost.dev/schemas/v1/workspace-plugins.json'
} as const
