import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { validateConnector, validateEnvironment, validateFlow, type Connector } from '@vvpost/schemas'
import { connectorToFlows } from '@vvpost/core/flows/inherit'
import type { ProjectTemplate, ProjectTemplateId } from '@shared/ipc'

/**
 * Modelos de projeto novo: o mínimo para a primeira requisição
 * sair com ambiente e auth identificados. Segredos entram como __REQUIRED_SECRET__ (o valor vai
 * para o vault local pelo módulo Secrets ou pelos Primeiros passos); nada liga MCP, plugins ou
 * proxy de segredos.
 */
const GITIGNORE = '.vvpost/secrets.local.json\n'

const environment = (id: string, name: string, baseUrl: string, secret: boolean, extra: object = {}) => ({
  id,
  name,
  variables: {
    BASE_URL: { type: 'string', value: baseUrl, description: 'URL base da API neste ambiente' },
    ...(secret && {
      API_TOKEN: {
        type: 'string',
        value: '__REQUIRED_SECRET__',
        isSecret: true,
        description: 'Token da API; o valor fica no vault local, fora do Git'
      }
    }),
    ...extra
  }
})

const readme = (title: string, body: string) =>
  `# ${title}\n\n${body}\n\nProjeto VVPost: fluxos em \`flows/\` (a base com a URL e a auth, e um arquivo por requisição que herda dela) e ambientes em \`environments/\`. ` +
  'Segredos ficam no cofre local do VVPost, cifrado e fora desta pasta.\n'

const FLOW_SUFFIX = '.flow.vvpost.json'

/**
 * O conector do modelo no formato do workspace (docs/flows.md, Herança): o fluxo-base em
 * flows/<id>/<id>.flow.vvpost.json e um fluxo de requisição por endpoint ao lado, como o
 * "Converter para fluxos" grava.
 */
function asFlowFiles(connector: Connector): Record<string, unknown> {
  const { base, requests, unsupported } = connectorToFlows(connector)
  if (unsupported.length) throw new Error(`O modelo ${connector.id} não cabe em fluxos: ${unsupported.join('; ')}`)
  const folder = `flows/${connector.id}`
  return Object.fromEntries([
    [`${folder}/${connector.id}${FLOW_SUFFIX}`, base],
    ...requests.map((r) => [`${folder}/${r.id.slice(connector.id.length + 1)}${FLOW_SUFFIX}`, r])
  ])
}

const TEMPLATES: Record<ProjectTemplateId, { name: string; description: string; files: () => Record<string, unknown> }> = {
  empty: {
    name: 'Projeto vazio',
    description: 'Um ambiente Desenvolvimento com BASE_URL. Os fluxos você cria pelo Novo do explorador.',
    files: () => ({
      'environments/dev.env.json': environment('env.dev', 'Desenvolvimento', 'http://localhost:3000', false),
      '.gitignore': GITIGNORE,
      'README.md': readme('Projeto VVPost', 'Comece criando um fluxo-base (URL e auth) pelo Novo do explorador.')
    })
  },
  'rest-api': {
    name: 'API REST com token',
    description:
      'Um fluxo-base com URL base e auth Bearer, três requisições que herdam dela (com cenários) e os ambientes Desenvolvimento e Homologação.',
    files: () => ({
      ...asFlowFiles({
        id: 'api',
        name: 'Minha API',
        version: '1.0.0',
        description: 'URL base e token Bearer vêm do ambiente; os endpoints herdam os dois.',
        config: {
          baseUrl: '{{BASE_URL}}',
          headers: { Accept: 'application/json' },
          auth: { type: 'bearer', token: '{{API_TOKEN}}' }
        },
        endpoints: [
          {
            id: 'list_items',
            name: 'Listar itens',
            method: 'GET',
            path: '/items',
            scenarios: [
              {
                id: 'ok',
                name: 'Responde 200',
                assertions: [
                  { target: 'status', operator: 'equals', expected: 200 },
                  {
                    target: 'responseTimeMs',
                    operator: 'lessThan',
                    expected: 2000
                  }
                ]
              }
            ]
          },
          {
            id: 'get_item',
            name: 'Buscar item',
            method: 'GET',
            path: '/items/{{item_id}}'
          },
          {
            id: 'create_item',
            name: 'Criar item',
            method: 'POST',
            path: '/items',
            headers: { 'Content-Type': 'application/json' },
            body: { name: 'Exemplo' },
            scenarios: [
              {
                id: 'created',
                name: 'Cria o item',
                assertions: [{ target: 'status', operator: 'equals', expected: 201 }]
              }
            ]
          }
        ]
      }),
      'environments/dev.env.json': environment('env.dev', 'Desenvolvimento', 'http://localhost:3000', true, {
        item_id: { type: 'string', value: '1' }
      }),
      'environments/hml.env.json': environment('env.hml', 'Homologação', 'https://hml.api.exemplo.com', true),
      '.gitignore': GITIGNORE,
      'README.md': readme(
        'Minha API',
        'Troque a BASE_URL de cada ambiente, configure o API_TOKEN em Secrets e rode "Listar itens" no Quick Request.'
      )
    })
  }
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = Object.entries(TEMPLATES).map(([id, t]) => ({
  id: id as ProjectTemplateId,
  name: t.name,
  description: t.description,
  files: Object.keys(t.files())
}))

export const isProjectTemplate = (id: unknown): id is ProjectTemplateId => typeof id === 'string' && Object.hasOwn(TEMPLATES, id)

/** O que pode já estar na pasta: um repositório recém-criado ou o lixo do sistema. */
const IGNORABLE = new Set(['.git', '.DS_Store', 'Thumbs.db', 'desktop.ini'])

/**
 * Grava o modelo em `dir`, que precisa estar vazia: um projeto novo nunca sobrescreve arquivos
 * escritos à mão. Os arquivos passam pelo schema antes de ir para o disco. Devolve os caminhos.
 */
export async function createFromTemplate(dir: string, id: ProjectTemplateId): Promise<string[]> {
  const existing = (
    await readdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return []
      throw err
    })
  ).filter((name) => !IGNORABLE.has(name))
  if (existing.length) {
    throw new Error(
      `A pasta já tem ${existing.length === 1 ? `o arquivo ${existing[0]}` : `${existing.length} arquivos (${existing.slice(0, 3).join(', ')}…)`}. Escolha uma pasta vazia para o projeto novo, ou use Abrir workspace.`
    )
  }
  const files = TEMPLATES[id].files()
  for (const [path, data] of Object.entries(files)) {
    const check = path.endsWith('.connector.vvpost.json')
      ? validateConnector(data)
      : path.endsWith(FLOW_SUFFIX)
        ? validateFlow(data)
        : path.endsWith('.env.json')
          ? validateEnvironment(data)
          : null
    if (check && !check.ok) throw new Error(`O modelo ${id} gerou ${path} fora do schema: ${check.issues[0]?.message}`)
  }
  for (const [path, data] of Object.entries(files)) {
    const target = join(dir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { flag: 'wx' })
  }
  return Object.keys(files)
}
