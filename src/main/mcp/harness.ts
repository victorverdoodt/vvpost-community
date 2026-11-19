// O "harness" de documentação do MCP: prompts prontos e resources que orientam a IA a documentar
// o projeto no VVPost (documento do projeto, páginas em docs/, modelos), em vez de .md soltos.

export interface McpPromptArgument {
  name: string
  description: string
  required?: boolean
}

export interface McpPrompt {
  name: string
  title: string
  description: string
  arguments: McpPromptArgument[]
  /** O texto da mensagem do usuário, montado com os argumentos já validados. */
  build(args: Record<string, string>): string
}

export class PromptError extends Error {}

const WORKFLOW =
  'Use as ferramentas de documentação do VVPost (get_docs_project, save_docs_project, write_docs_page, generate_docs) e não crie arquivos .md soltos fora delas. ' +
  'Leia antes o guia em vvpost://docs/guia se ainda não leu.'

export const DOC_PROMPTS: readonly McpPrompt[] = [
  {
    name: 'documentar_projeto',
    title: 'Documentar o projeto',
    description:
      'Escreve a documentação do projeto inteiro no VVPost: visão geral, arquitetura, guias e a referência das APIs, num documento só e no padrão do modelo.',
    arguments: [
      { name: 'template', description: 'Modelo de partida quando ainda não há documento (ex.: builtin:c4, builtin:arc42, builtin:diataxis). Padrão: builtin:api-guide.' },
      { name: 'foco', description: 'O que priorizar (ex.: "onboarding de quem integra", "decisões de arquitetura").' }
    ],
    build: (a) =>
      [
        'Documente este projeto no VVPost.',
        WORKFLOW,
        '',
        '1. Chame get_docs_project e get_api_catalog para entender o que já existe.',
        `2. Se source vier null, comece do modelo com save_docs_project { template: "${a['template'] || 'builtin:api-guide'}", dryRun: true } e depois sem dryRun.`,
        '3. Escreva as páginas de nível de projeto com write_docs_page (ex.: docs/visao-geral.md, docs/arquitetura.md, docs/guias/<tema>.md), a partir do código e do catálogo.',
        '4. No documento-fonte, junte as páginas com {{> include docs/<pagina>.md}} e use {{> map}}, {{> connector <id>}}, {{> endpoint <conector>/<endpoint>}}, {{> flows}} e {{> reference}} para o que vem do projeto.',
        '5. Grave com save_docs_project (dryRun antes), corrija os diagnósticos e confira o resultado com generate_docs sem argumentos.',
        ...(a['foco'] ? ['', `Foco: ${a['foco']}`] : [])
      ].join('\n')
  },
  {
    name: 'documentar_conector',
    title: 'Documentar um conector',
    description: 'Escreve a documentação de um conector e dos seus endpoints e a liga ao documento do projeto.',
    arguments: [{ name: 'connector', description: 'Id do conector (veja get_api_catalog).', required: true }],
    build: (a) =>
      [
        `Documente o conector "${a['connector']}" no VVPost.`,
        WORKFLOW,
        '',
        `1. Chame generate_docs { connector: "${a['connector']}" } para ver o que já está documentado e o que falta (endpoints sem descrição, sem exemplos, sem cenários).`,
        '2. Escreva a documentação do conector e de cada endpoint (propósito, regras de negócio, erros, exemplos) com edit_project no documento do conector (writeDoc: <conector>.connector.vvpost.md, ou <base>.flow.vvpost.md num fluxo-base, uma seção {#endpointId} por endpoint); leia o formato com get_source e get_schema.',
        `3. Garanta que o documento do projeto (get_docs_project) traga o conector com {{> connector ${a['connector']}}}; se não trouxer, acrescente com save_docs_project.`,
        `4. Confira com generate_docs { connector: "${a['connector']}" } e generate_docs sem argumentos.`
      ].join('\n')
  },
  {
    name: 'aplicar_template',
    title: 'Aplicar um modelo de documentação',
    description:
      'Reorganiza o documento do projeto num modelo de metodologia (C4, arc42, Diátaxis, ADR) ou num modelo do projeto, preservando o conteúdo já escrito.',
    arguments: [{ name: 'template', description: 'Id do modelo (ex.: builtin:c4). Padrão: builtin:c4.' }],
    build: (a) => {
      const template = a['template'] || 'builtin:c4'
      return [
        `Aplique o modelo de documentação "${template}" ao documento do projeto no VVPost.`,
        WORKFLOW,
        '',
        '1. Chame get_docs_project e guarde o source atual e as páginas em docs/.',
        `2. Veja o resultado do modelo com save_docs_project { template: "${template}", dryRun: true }.`,
        '3. Leve o conteúdo já escrito para as seções do modelo: texto de projeto vira páginas com write_docs_page incluídas com {{> include}}, e o que vem do projeto continua por diretivas. Não perca conteúdo.',
        ...(template === 'builtin:c4'
          ? ['4. No C4, descreva contexto, contêineres e componentes com diagramas Mermaid (C4Context, C4Container) a partir do código e do catálogo.']
          : []),
        `${template === 'builtin:c4' ? 5 : 4}. Grave com save_docs_project { template: "${template}", source } e corrija os diagnósticos; confira com generate_docs.`
      ].join('\n')
    }
  }
]

export interface McpResource {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
  read(workspaceDir: string): Promise<string>
}

export const DOC_RESOURCES: readonly McpResource[] = [
  {
    uri: 'vvpost://docs/guia',
    name: 'guia-documentacao',
    title: 'Guia de documentação do VVPost',
    description: 'Como documentar o projeto no VVPost: arquivos, diretivas {{> ...}}, modelos de metodologia e o passo a passo pelo MCP.',
    mimeType: 'text/markdown',
    read: async () => (await import('@vvpost/core/docs')).docsAgentGuide()
  },
  {
    uri: 'vvpost://docs/modelos',
    name: 'modelos-documentacao',
    title: 'Modelos de documentação',
    description: 'Os modelos de documentação disponíveis (metodologias e os do projeto), com id, nome e descrição.',
    mimeType: 'application/json',
    read: async (dir) => {
      const docs = await import('@vvpost/core/docs')
      const { templates, issues } = await docs.listDocTemplates(dir)
      const list = templates.map((t) => ({ id: t.id, name: t.name, description: t.description, origin: t.origin }))
      return JSON.stringify({ templates: list, ...(issues.length && { issues }) }, null, 2)
    }
  }
]

/** Valida os argumentos de prompts/get: obrigatórios presentes, todos texto, nenhum desconhecido. */
export function promptArguments(prompt: McpPrompt, raw: unknown): Record<string, string> {
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(args)) {
    if (!prompt.arguments.some((a) => a.name === k)) throw new PromptError(`argumento desconhecido: ${k}`)
    if (typeof v !== 'string') throw new PromptError(`argumento ${k} deve ser texto`)
    out[k] = v.trim()
  }
  for (const a of prompt.arguments) if (a.required && !out[a.name]) throw new PromptError(`argumento obrigatório: ${a.name}`)
  return out
}
