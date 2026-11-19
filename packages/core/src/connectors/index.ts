// Chunk carregado sob demanda pelo services.ts, na primeira requisição com conector
// ou ambiente: nada daqui (nem o ajv dos schemas) pesa no cold start.
export { readConnectorSource, saveConnector } from './edit'
export { createAuthEngine, type AuthEngine } from './auth'
export { sendHeadless } from './headless'
export { buildRegistry, validateEndpointBody } from './registry'
export { summarizeWorkspace } from './summary'
export { setSharedConnectors, type SharedConnector, type SharedConnectorsProvider } from './shared'
export { addFlowProjectRefs, loadWorkspace, otherProjectBases, type LoadedWorkspace, type LoadWorkspaceOptions } from './workspace'
