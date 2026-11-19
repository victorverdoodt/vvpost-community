import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { DocsConfig } from '@vvpost/schemas'
import { findFiles, type LoadedWorkspace } from '../connectors/workspace'
import { isProjectDir } from '../projects'
import { createSecretSanitizer } from '../sanitizer'
import { DocsError } from './build'
import { DOCS_STARTER_SOURCE, parseDocsConfig } from './compose'

/** Modelo próprio de documentação: um arquivo com este sufixo, no projeto ou na pasta do usuário. */
export const DOC_TEMPLATE_SUFFIX = '.doc-template.vvpost.json'
const MAX_TEMPLATE_BYTES = 1024 * 1024

/**
 * De onde o modelo vem: do VVPost, do projeto (vai para o Git), do Compartilhado do workspace
 * (docs/templates na raiz, vale para todos os projetos dele) ou do usuário (todos os projetos).
 */
export type DocTemplateOrigin = 'builtin' | 'project' | 'shared' | 'user'

export interface DocTemplate {
  /** builtin:<id>, project:<arquivo> ou user:<arquivo>. */
  id: string
  name: string
  description: string
  origin: DocTemplateOrigin
  /** Arquivo do modelo (project: relativo ao workspace; user: o nome na pasta do usuário). */
  file?: string
  /** Formato que o modelo traz (sem source: o documento-fonte do projeto fica onde está). */
  config: DocsConfig
  source: string
}

const builtin = (id: string, name: string, description: string, config: DocsConfig, source: string): DocTemplate => ({
  id: `builtin:${id}`,
  name,
  description,
  origin: 'builtin',
  config,
  source
})

/**
 * Modelos que vêm com o VVPost, cada um seguindo uma metodologia. Os trechos {{> ...}} são
 * montados do projeto; o texto em itálico é o que a pessoa troca pelo do seu sistema.
 */
export const BUILTIN_DOC_TEMPLATES: readonly DocTemplate[] = [
  builtin(
    'api-guide',
    'Guia da API',
    'Visão geral, ambientes e a referência completa gerada do projeto. O ponto de partida padrão.',
    { cover: true, toc: true },
    DOCS_STARTER_SOURCE
  ),
  builtin(
    'c4',
    'C4 (contexto, contêineres, componentes)',
    'Modelo C4 de Simon Brown: contexto do sistema, contêineres, componentes e código, com diagramas C4 em Mermaid e a referência dos conectores como componentes.',
    { cover: true, toc: true, numberHeadings: true, subtitle: 'Arquitetura no modelo C4' },
    `## Contexto do sistema (nível 1)

_Quem usa o sistema e com quais sistemas externos ele conversa. Troque os nomes do diagrama pelos do seu domínio._

\`\`\`mermaid
C4Context
  title Contexto do sistema
  Person(cliente, "Cliente", "Quem consome a API")
  System(api, "Nossa API", "O sistema documentado aqui")
  System_Ext(externo, "Sistema externo", "Pagamentos, identidade, mensageria...")
  Rel(cliente, api, "Usa", "HTTPS")
  Rel(api, externo, "Chama", "HTTPS")
\`\`\`

## Contêineres (nível 2)

_As unidades que rodam e guardam dados: aplicações, serviços, bancos, filas._

_Cada serviço que tem conector no catálogo é ligado a ele pelo nome ou por \`%% vvpost:bind <alias> connector:<id>\`: o lint avisa quando o diagrama e o catálogo divergem._

\`\`\`mermaid
C4Container
  title Contêineres
  Person(cliente, "Cliente")
  System_Boundary(sistema, "Nossa API") {
    Container(gateway, "API Gateway", "HTTP", "Autentica e roteia")
    Container(servico, "Serviço", "Aplicação", "Regras de negócio")
    ContainerDb(banco, "Banco de dados", "SQL", "Dados do domínio")
  }
  Rel(cliente, gateway, "Chama", "HTTPS")
  Rel(gateway, servico, "Encaminha")
  Rel(servico, banco, "Lê e grava")
\`\`\`

Mapa das integrações do projeto (conectores, herança, endpoints e fluxos):

{{> map}}

## Componentes (nível 3)

_Cada conector é um componente de integração: herança, autenticação, endpoints e os cenários que validam cada um._

{{> reference}}

## Dinâmica

_Os fluxos que encadeiam as chamadas entre os componentes._

{{> flows}}

## Implantação

{{> environments}}

{{> variables}}

## Decisões de arquitetura

| # | Decisão | Status | Data |
| --- | --- | --- | --- |
| 1 | _Descreva a decisão_ | proposta | _aaaa-mm-dd_ |
`
  ),
  builtin(
    'arc42',
    'arc42 (resumido)',
    'As seções do arc42 para documentar arquitetura: objetivos, restrições, contexto, solução, blocos, execução, implantação, conceitos, decisões, qualidade, riscos e glossário.',
    { cover: true, toc: true, numberHeadings: true, subtitle: 'Documentação de arquitetura (arc42)' },
    `## Introdução e objetivos

_O que o sistema faz, os principais requisitos e quem são as partes interessadas._

{{> summary}}

## Restrições

_Técnicas, organizacionais e de convenções que a solução precisa respeitar._

## Contexto e escopo

_O sistema e seus vizinhos: quem chama e quem é chamado._

{{> map}}

## Estratégia da solução

_As decisões fundamentais e as tecnologias escolhidas._

## Visão de blocos

{{> reference}}

## Visão de execução

{{> flows}}

## Visão de implantação

{{> environments}}

{{> variables}}

## Conceitos transversais

_Autenticação, tratamento de erros, observabilidade, versionamento._

## Decisões de arquitetura

_Registre aqui as decisões (ADRs) com contexto, decisão e consequências._

## Requisitos de qualidade

| Atributo | Cenário | Meta |
| --- | --- | --- |
| Desempenho | _Ex.: 95% das chamadas_ | _< 300 ms_ |

## Riscos e dívidas técnicas

{{> issues}}

## Glossário

| Termo | Significado |
| --- | --- |
| _Termo_ | _Definição_ |
`
  ),
  builtin(
    'diataxis',
    'Diátaxis (tutorial, guias, referência, explicação)',
    'Os quatro tipos de documentação do Diátaxis: tutoriais para aprender, guias práticos para resolver, referência para consultar e explicação para entender.',
    { cover: true, toc: true, subtitle: 'Documentação no modelo Diátaxis' },
    `## Tutoriais

_Aprender fazendo: um caminho guiado, do zero até a primeira chamada que funciona._

1. _Peça as credenciais do ambiente de desenvolvimento._
2. _Faça a primeira chamada._

{{> environments}}

## Guias práticos

_Receitas para tarefas específicas. Inclua trechos de outras docs com {{> include}}._

## Referência

_Consulta técnica completa, gerada do projeto._

{{> reference}}

{{> variables}}

## Explicação

_O porquê das escolhas: conceitos, arquitetura e decisões._

{{> map}}

{{> flows}}
`
  ),
  builtin(
    'adr',
    'Registro de decisões (ADR)',
    'Decisões de arquitetura no formato de Michael Nygard (contexto, decisão, consequências), com a referência técnica do projeto no fim.',
    { cover: true, toc: true, numberHeadings: true, subtitle: 'Registro de decisões de arquitetura' },
    `## ADR 1: _título da decisão_

- **Status:** proposta
- **Data:** _aaaa-mm-dd_

### Contexto

_A situação e as forças em jogo que levaram à decisão._

### Decisão

_O que foi decidido, na voz ativa: "Vamos..."._

### Consequências

_O que fica mais fácil e o que fica mais difícil depois dela._

## Referência técnica

{{> summary}}

{{> reference}}
`
  )
]

/** Modelo validado: nome, descrição, o formato pelo schema docs.json (sem source) e o texto. */
export function parseDocTemplate(data: unknown, where: string): Omit<DocTemplate, 'id' | 'origin' | 'file'> {
  const d = data as Record<string, unknown> | null
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new DocsError(`${where}: o modelo precisa ser um objeto`)
  if (typeof d['name'] !== 'string' || !d['name'].trim() || d['name'].length > 120) throw new DocsError(`${where}: "name" precisa ser texto (até 120 caracteres)`)
  if (d['description'] !== undefined && typeof d['description'] !== 'string') throw new DocsError(`${where}: "description" precisa ser texto`)
  if (typeof d['source'] !== 'string') throw new DocsError(`${where}: "source" precisa ser o Markdown do modelo`)
  const { source: _path, ...config } = parseDocsConfig(d['config'] ?? {})
  return { name: d['name'].trim(), description: (d['description'] as string | undefined) ?? '', config, source: d['source'] }
}

async function readTemplate(path: string, where: string): Promise<Omit<DocTemplate, 'id' | 'origin' | 'file'>> {
  const text = await readFile(path, 'utf8')
  if (Buffer.byteLength(text) > MAX_TEMPLATE_BYTES) throw new DocsError(`${where}: passa de 1 MB`)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new DocsError(`${where}: JSON inválido (${(err as Error).message})`)
  }
  return parseDocTemplate(data, where)
}

/**
 * Os modelos disponíveis: os do VVPost, os do projeto (*.doc-template.vvpost.json em qualquer
 * pasta do workspace, compartilhados pelo Git) e os do usuário (`userDir`, valem em todo
 * projeto). Arquivo inválido vira problema e fica de fora.
 */
export async function listDocTemplates(
  dir: string,
  userDir?: string
): Promise<{ templates: DocTemplate[]; issues: { file: string; message: string }[] }> {
  const templates: DocTemplate[] = [...BUILTIN_DOC_TEMPLATES]
  const issues: { file: string; message: string }[] = []
  const root = resolve(dir)
  for (const path of await findFiles(root, DOC_TEMPLATE_SUFFIX)) {
    const file = relative(root, path).split(sep).join('/')
    try {
      templates.push({ id: `project:${file}`, origin: 'project', file, ...(await readTemplate(path, file)) })
    } catch (err) {
      issues.push({ file, message: (err as Error).message })
    }
  }
  // Num projeto de um workspace, os modelos do Compartilhado: o mesmo padrão em todos os projetos.
  if (isProjectDir(root)) {
    const sharedDir = join(dirname(root), 'docs', 'templates')
    const names = await readdir(sharedDir).catch(() => [] as string[])
    for (const name of names.filter((n) => n.endsWith(DOC_TEMPLATE_SUFFIX)).sort()) {
      const file = `docs/templates/${name}`
      try {
        templates.push({ id: `shared:${file}`, origin: 'shared', file, ...(await readTemplate(join(sharedDir, name), file)) })
      } catch (err) {
        issues.push({ file: `../${file}`, message: (err as Error).message })
      }
    }
  }
  if (userDir) {
    const names = await readdir(userDir).catch(() => [] as string[])
    for (const name of names.filter((n) => n.endsWith(DOC_TEMPLATE_SUFFIX)).sort()) {
      try {
        templates.push({ id: `user:${name}`, origin: 'user', file: name, ...(await readTemplate(join(userDir, name), name)) })
      } catch (err) {
        issues.push({ file: `~/${name}`, message: (err as Error).message })
      }
    }
  }
  return { templates, issues }
}

/** Nome de arquivo de um modelo a partir do nome dado pela pessoa. */
export function docTemplateFileName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'modelo'}${DOC_TEMPLATE_SUFFIX}`
}

/**
 * Grava um modelo próprio: no projeto (docs/templates/, vai para o Git) ou na pasta do
 * usuário. Recusa valor de segredo do workspace (o modelo também é compartilhado).
 */
export async function saveDocTemplate(
  ws: LoadedWorkspace,
  input: { name: string; description?: string; config: unknown; source: string },
  target: { origin: 'project' } | { origin: 'user'; dir: string }
): Promise<DocTemplate> {
  const parsed = parseDocTemplate(input, 'modelo')
  const json = `${JSON.stringify({ name: parsed.name, description: parsed.description, config: parsed.config, source: parsed.source }, null, 2)}\n`
  const sanitizer = createSecretSanitizer()
  sanitizer.addWorkspace(ws)
  if (sanitizer.leaks(json)) throw new DocsError('o modelo tem o valor de um segredo do workspace; nada foi gravado')
  const name = docTemplateFileName(parsed.name)
  if (target.origin === 'user') {
    await mkdir(target.dir, { recursive: true })
    await writeFile(join(target.dir, name), json)
    return { id: `user:${name}`, origin: 'user', file: name, ...parsed }
  }
  const { workspaceWritePath } = await import('./compose')
  const file = `docs/templates/${name}`
  await writeFile(await workspaceWritePath(ws.dir, file), json)
  return { id: `project:${file}`, origin: 'project', file, ...parsed }
}

/**
 * O rascunho que um modelo dá ao projeto: o texto do modelo e o formato dele, mantendo o que
 * identifica o projeto (título, subtítulo, organização, versão, logo e onde fica a fonte).
 */
export function applyDocTemplate(template: DocTemplate, current: DocsConfig): { config: DocsConfig; source: string } {
  const keep: (keyof DocsConfig)[] = ['title', 'subtitle', 'organization', 'version', 'logo', 'source']
  const config: DocsConfig = { ...template.config }
  for (const key of keep) if (current[key] !== undefined) (config as Record<string, unknown>)[key] = current[key]
  // Lembra a metodologia escolhida: o estilo da documentação mostra qual está em uso.
  config.methodology = template.name
  return { config, source: template.source }
}
