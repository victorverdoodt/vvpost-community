import type { ConnectorAuth } from '@vvpost/schemas'
import type { CatalogConnector, ConnectorCatalog, HttpMethod } from '../types'
import { joinPath, resolveConnector } from './resolve'
import { isProtectedEnvironment } from '../policy/protected'
import { environmentValues, type LoadedWorkspace } from './workspace'

/** O que o renderer vê do workspace: modelos com {{VAR}}, nunca valores de segredo. */
export function summarizeWorkspace(ws: LoadedWorkspace): ConnectorCatalog {
  const connectors: CatalogConnector[] = [...ws.connectors.values()].map((raw) => {
    try {
      const c = resolveConnector(raw.id, ws.connectors)
      const shared = ws.shared?.get(raw.id)
      const file = ws.connectorFiles.get(raw.id)
      return {
        id: c.id,
        name: c.name,
        ...(shared && { shared }),
        chain: c.chain,
        ...(file && { file }),
        ...(ws.flowSources?.has(raw.id) && { asFlow: true as const }),
        baseUrl: c.baseUrl === undefined ? undefined : joinPath(c.baseUrl, c.basePath),
        headers: Object.entries(c.headers).map(([name, value]) => ({ name, value })),
        auth: c.auth && { type: c.auth.config.type, from: c.auth.from, summary: describeAuth(c.auth.config) },
        tlsFrom: c.tls?.from,
        ...(c.scripts.length && { scripts: c.scripts }),
        endpoints: c.endpoints.map((e) => ({
          id: e.id,
          name: e.name,
          ...(ws.flowSources?.has(`${raw.id}/${e.id}`) && { flowFile: ws.flowSources.get(`${raw.id}/${e.id}`) }),
          method: e.method as HttpMethod,
          path: e.path,
          ...(e.requiresAuth !== undefined && { requiresAuth: e.requiresAuth }),
          headers: Object.entries(e.headers ?? {}).map(([name, value]) => ({ name, value })),
          body: e.body === undefined ? undefined : typeof e.body === 'string' ? e.body : JSON.stringify(e.body, null, 2),
          ...(e.bodySchema && { bodySchema: e.bodySchema }),
          ...(e.payload && { payload: e.payload }),
          ...(e.plugin && { plugin: e.plugin }),
          ...((e.scripts?.pre?.trim() || e.scripts?.post?.trim()) && { scripts: e.scripts }),
          // Cenários vão como escritos no arquivo: modelos com {{VAR}}, sem valores do ambiente.
          scenarios: (e.scenarios ?? []).map((sc) => ({
            id: sc.id,
            name: sc.name,
            ...(sc.description !== undefined && { description: sc.description }),
            ...(sc.overrides && { overrides: sc.overrides }),
            assertions: sc.assertions
          })),
          ...(e.examples?.length && { examples: e.examples })
        }))
      }
    } catch (err) {
      return { id: raw.id, name: raw.name, chain: [raw.id], headers: [], endpoints: [], error: (err as Error).message }
    }
  })
  connectors.sort((a, b) => a.name.localeCompare(b.name))
  const flowFiles = [...new Set(ws.flowSources?.values() ?? [])]
  const legacy = [...ws.connectors.keys()].filter((id) => !ws.shared?.has(id) && !ws.flowSources?.has(id)).length
  return {
    dir: ws.dir,
    connectors,
    environments: [...ws.environments.values()].map((e) => ({
      id: e.id,
      name: e.name,
      missingSecrets: [...environmentValues(ws, e.id).missingSecrets],
      protected: isProtectedEnvironment(e)
    })),
    issues: ws.issues,
    ...(flowFiles.length && { flowFiles }),
    ...(legacy && { legacy })
  }
}

export function describeAuth(auth: Exclude<ConnectorAuth, { type: 'none' }>): string {
  switch (auth.type) {
    case 'bearer':
      return `Token fixo em ${auth.header ?? 'Authorization'}`
    case 'apiKey':
      return `API key em ${auth.in === 'query' ? 'query' : 'header'} ${auth.name}`
    case 'basic':
      return 'Basic (usuário e senha)'
    case 'oauth2':
      return auth.grantType === 'authorization_code'
        ? `OAuth2 authorization code${auth.pkce === false ? '' : ' com PKCE'} (login no navegador) em ${auth.authUrl ?? auth.tokenUrl}`
        : `OAuth2 ${auth.grantType === 'password' ? 'password' : 'client credentials'} em ${auth.tokenUrl}`
    case 'login':
      return `Login em ${auth.request.method ?? 'POST'} ${auth.request.url}`
    case 'digest':
      return 'Digest (usuário e senha, responde ao desafio do servidor)'
    case 'ntlm':
      return `NTLM${auth.domain ? ` no domínio ${auth.domain}` : ''} (usuário e senha)`
    case 'awsSigV4':
      return `AWS SigV4 (${auth.service} em ${auth.region})`
    case 'oauth1':
      return `OAuth 1.0 (${auth.signatureMethod ?? 'HMAC-SHA1'})`
  }
}
