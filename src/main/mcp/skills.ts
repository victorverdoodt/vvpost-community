// Skills over MCP (extensão io.modelcontextprotocol/skills, SEP-2640): o servidor publica, junto com as
// ferramentas, os passo a passos de uso no formato Agent Skills. Cada arquivo de uma skill é um resource
// skill://<nome>/<arquivo>, lido pelo resources/read; skills/list e skills/get devolvem o manifesto com o
// SHA-256 e o tamanho de cada arquivo, que o cliente confere antes de carregar a skill.
// Spec: https://skills.extensions.modelcontextprotocol.io/specification/beta/skills

import { createHash } from 'node:crypto'

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
/** O que o servidor anuncia em capabilities.extensions: lê diretórios (resources/directory/read). */
export const SKILLS_CAPABILITY = { directoryRead: true } as const

const SCHEME = 'skill://'
/** O conteúdo só muda com a versão do servidor: o cliente pode guardar o manifesto por 1 hora. */
const SKILLS_TTL_MS = 3_600_000

interface SkillSource {
  name: string
  description: string
  /** O corpo do SKILL.md, depois do frontmatter. */
  body: string
  /** Arquivos de apoio, pelo caminho relativo à raiz da skill. */
  files?: () => Promise<Record<string, string>>
}

export interface SkillResource {
  uri: string
  digest: string
  size: number
}

export interface SkillEntry {
  uri: string
  frontmatter: { name: string; description: string; [key: string]: unknown }
  resources: SkillResource[]
}

interface SkillFile {
  uri: string
  mimeType: string
  bytes: Buffer
}

interface BuiltSkill {
  entry: SkillEntry
  files: SkillFile[]
}

const TOOLS_FIRST =
  'Use as ferramentas do servidor MCP do VVPost que publicou esta skill. Leia junto (get_api_catalog { view: "summary" }, get_source { ids }) ' +
  'e grave direto, sem dryRun: edit_project e write_docs_page validam, gravam tudo ou nada e devolvem o resultado conferido.'

const CREDENTIALS =
  'Credenciais: nunca peça nem escreva valores; use {{VAR}} de variável secreta, e a auth sai do cofre do VVPost.'

const SOURCES: readonly SkillSource[] = [
  {
    name: 'atualizar-docs-com-o-codigo',
    description:
      'Atualiza o catálogo e a documentação do VVPost no mesmo trabalho em que o código de uma API muda (rota, DTO, regra, conector). Use sempre que mudar uma API documentada no VVPost.',
    body: `# Atualizar a documentação junto com o código

${TOOLS_FIRST}

1. Descubra o que a mudança toca: \`find_references { terms }\` diz em \`exact\` onde cada termo aparece no catálogo e nas páginas.
2. Conector que segue uma spec OpenAPI gerada pelo código (\`source\`): regere a spec (o build do projeto) e rode
   \`sync_openapi { apply: true }\` em vez de editar os endpoints à mão. Trate os \`breaks\` da resposta.
3. O resto do contrato é um \`edit_project\` só: \`replaceReferences\` (escolha o \`in\` pelo que o \`find_references\` disse),
   \`setSchemaField { fillExamples: true }\` e \`writePage { file, edits }\` nas páginas de \`docs/\` que descrevem o que mudou.
4. Rota ou regra nova ganha cenário no fluxo do endpoint.
5. Com \`documentErrors\` ou \`lint\` na resposta, corrija na mesma mudança (diretiva quebrada, C4 ou ADR velho).
   Com \`stalePdf\`, rode \`export_docs\`; sem ele, não exporte.
6. Com a pessoa editando no app, mande \`expect {caminho: versão}\`; com \`CONFLICT\` nada foi gravado: releia e repita.

Não crie arquivos .md soltos: a documentação mora no documento do projeto (veja a skill documentar-projeto).
`
  },
  {
    name: 'chamar-api',
    description:
      'Chama uma API do catálogo do VVPost pelo execute_dry_run, com a credencial do cofre, em vez de curl ou script. Use para testar um endpoint, conferir uma resposta ou rodar um cenário.',
    body: `# Chamar uma API do catálogo

Nunca use curl, fetch ou um script para chamar uma API que está no VVPost: a credencial só existe no cofre, e
o VVPost a aplica sem que ela passe pela conversa.

1. Ache o endpoint: \`get_api_catalog { view: "summary" }\` (ids de conectores, endpoints e ambientes).
2. Antes do primeiro disparo, ou quando um disparo falhar sem motivo claro, \`check_readiness\` diz o que impede de rodar
   (variável sem valor, ambiente sem URL, auth incompleta), por ambiente e de uma vez.
3. Dispare com \`execute_dry_run { connectorId, environmentIds, request: { endpointId, overrides, select } }\`.
   Use \`select\` para trazer só os campos da resposta que interessam.
4. Cenário salvo: \`execute_flow\`.
5. Recusa com \`BLOCKED\` vem da política (ambiente protegido, método não permitido, revisão no console): diga à pessoa
   o motivo da resposta em vez de contornar.

${CREDENTIALS}
`
  },
  {
    name: 'documentar-projeto',
    description:
      'Escreve a documentação do projeto inteiro no VVPost (visão geral, arquitetura, guias e a referência das APIs) num documento só, no padrão de um modelo. Use quando pedirem para documentar o sistema ou criar a documentação.',
    body: `# Documentar o projeto no VVPost

Use as ferramentas de documentação do VVPost (get_docs_project, save_docs_project, write_docs_page, generate_docs)
e não crie arquivos .md soltos fora delas. O guia completo (arquivos, diretivas, diagramas e modelos) está em
[references/guia.md](references/guia.md).

1. Chame \`get_docs_project\` e \`get_api_catalog\` para entender o que já existe.
2. Sem documento ainda (\`source\` null), comece de um modelo: \`save_docs_project { template: "builtin:api-guide" }\`
   (ou \`builtin:c4\`, \`builtin:arc42\`, \`builtin:diataxis\`, conforme o foco que a pessoa pediu).
3. Escreva as páginas de nível de projeto com \`write_docs_page\` (ex.: docs/visao-geral.md, docs/arquitetura.md,
   docs/guias/<tema>.md), a partir do código e do catálogo.
4. No documento-fonte, junte as páginas com \`{{> include docs/<pagina>.md}}\` e cite o que vem do projeto com
   \`{{> map}}\`, \`{{> connector <id>}}\`, \`{{> endpoint <conector>/<endpoint>}}\`, \`{{> flows}}\` e \`{{> reference}}\`,
   em vez de copiar detalhes à mão.
5. Grave com \`save_docs_project\`, corrija os diagnósticos e confira com \`generate_docs\` sem argumentos.

Para documentar um conector só, use a skill documentar-conector.
`,
    files: async () => ({ 'references/guia.md': (await import('@vvpost/core/docs')).docsAgentGuide() })
  },
  {
    name: 'documentar-conector',
    description:
      'Escreve a documentação de um conector do VVPost e dos seus endpoints (propósito, regras, erros, exemplos) e a liga ao documento do projeto. Use quando um conector ou endpoint estiver sem descrição.',
    body: `# Documentar um conector

1. \`generate_docs { connector: "<id>" }\` mostra o que já está documentado e o que falta (endpoints sem descrição,
   sem exemplos, sem cenários). Os ids estão no \`get_api_catalog\`.
2. Escreva a documentação do conector e de cada endpoint (propósito, regras de negócio, erros, exemplos) com
   \`edit_project\` no documento do conector (\`writeDoc\`: <conector>.connector.vvpost.md, ou <base>.flow.vvpost.md
   num fluxo-base), uma seção \`{#endpointId}\` por endpoint. O formato está no \`get_source\` e no \`get_schema\`.
3. Garanta que o documento do projeto (\`get_docs_project\`) traga o conector com \`{{> connector <id>}}\`; se não
   trouxer, acrescente com \`save_docs_project\`.
4. Confira com \`generate_docs { connector: "<id>" }\` e com \`generate_docs\` sem argumentos.
`
  },
  {
    name: 'aplicar-modelo-de-docs',
    description:
      'Reorganiza o documento do projeto do VVPost num modelo de metodologia (C4, arc42, Diátaxis, ADR) ou num modelo do projeto, sem perder o conteúdo já escrito. Use quando pedirem para seguir uma metodologia de documentação.',
    body: `# Aplicar um modelo de documentação

Os modelos disponíveis (metodologias e os do projeto) estão no resource \`vvpost://docs/modelos\`. Sem pedido
específico, use \`builtin:c4\`.

1. Chame \`get_docs_project\` e guarde o \`source\` atual e as páginas em docs/.
2. Veja o resultado do modelo com \`save_docs_project { template: "<id>", dryRun: true }\`.
3. Leve o conteúdo já escrito para as seções do modelo: texto de projeto vira páginas com \`write_docs_page\`
   incluídas com \`{{> include}}\`, e o que vem do projeto continua por diretivas. Não perca conteúdo.
4. No C4, descreva contexto, contêineres e componentes com diagramas Mermaid (C4Context, C4Container) a partir do
   código e do catálogo; \`{{> c4}}\` gera o de contexto direto do catálogo.
5. Grave com \`save_docs_project { template: "<id>", source }\`, corrija os diagnósticos e confira com \`generate_docs\`.
`
  }
]

const mimeOf = (path: string) => (path.endsWith('.md') ? 'text/markdown' : path.endsWith('.json') ? 'application/json' : 'text/plain')
const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** O frontmatter YAML: só name e description, com aspas de JSON (que o YAML lê igual). */
const skillMd = (s: SkillSource) => `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body}`

async function build(s: SkillSource): Promise<BuiltSkill> {
  const root = `${SCHEME}${s.name}`
  const extra = (await s.files?.()) ?? {}
  const files: SkillFile[] = [
    { uri: `${root}/SKILL.md`, mimeType: 'text/markdown', bytes: Buffer.from(skillMd(s), 'utf8') },
    ...Object.entries(extra).map(([path, text]) => ({ uri: `${root}/${path}`, mimeType: mimeOf(path), bytes: Buffer.from(text, 'utf8') }))
  ]
  return {
    entry: {
      uri: `${root}/SKILL.md`,
      frontmatter: { name: s.name, description: s.description },
      resources: files.map((f) => ({ uri: f.uri, digest: sha256(f.bytes), size: f.bytes.length }))
    },
    files
  }
}

export interface SkillCatalog {
  list(): Promise<SkillEntry[]>
  /** A entrada da skill cujo SKILL.md está em uri; null se não houver. */
  get(uri: string): Promise<SkillEntry | null>
  /** Um arquivo de skill para o resources/read; null se a uri não for de skill. */
  read(uri: string): Promise<{ uri: string; mimeType: string; text: string } | null>
  /** Os filhos diretos de um diretório de skill (resources/directory/read); null se não for diretório. */
  directory(uri: string): Promise<{ uri: string; name: string; mimeType: string }[] | null>
  ttlMs: number
}

/** O catálogo de skills do servidor. O conteúdo é montado uma vez, na primeira consulta. */
export function createSkillCatalog(sources: readonly SkillSource[] = SOURCES): SkillCatalog {
  let built: Promise<BuiltSkill[]> | null = null
  const all = () => (built ??= Promise.all(sources.map(build)))
  const files = async () => (await all()).flatMap((s) => s.files)
  return {
    ttlMs: SKILLS_TTL_MS,
    list: async () => (await all()).map((s) => s.entry),
    get: async (uri) => (await all()).find((s) => s.entry.uri === uri)?.entry ?? null,
    async read(uri) {
      const file = (await files()).find((f) => f.uri === uri)
      return file ? { uri: file.uri, mimeType: file.mimeType, text: file.bytes.toString('utf8') } : null
    },
    async directory(uri) {
      if (!uri.startsWith(SCHEME) || uri.endsWith('/')) return null
      const prefix = `${uri}/`
      const children = new Map<string, { uri: string; name: string; mimeType: string }>()
      for (const f of await files()) {
        if (!f.uri.startsWith(prefix)) continue
        const [name, ...rest] = f.uri.slice(prefix.length).split('/')
        const child = `${prefix}${name}`
        if (!children.has(child)) children.set(child, { uri: child, name: name!, mimeType: rest.length ? 'inode/directory' : f.mimeType })
      }
      return children.size ? [...children.values()].sort((a, b) => a.uri.localeCompare(b.uri)) : null
    }
  }
}
