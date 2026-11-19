import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { SchemaId, validateDocsConfig, type DocsConfig } from '@vvpost/schemas'
import { findFiles, type LoadedWorkspace } from '../connectors/workspace'
import { isProjectDir } from '../projects'
import { createSecretSanitizer } from '../sanitizer'
import type { FlowCatalog } from '../types'
import { DocsError, generateDocumentation, type GenerateDocsOptions } from './build'
import { renderDocFragment, slugBase, type DocFragment } from './markdown'
import { DIAGRAM_ORIGIN } from './diagram-origin'
import type { ApiDocument } from './model'

/** Modelo da documentação do projeto, na raiz do workspace (schema docs.json). */
export const DOCS_CONFIG_FILE = 'vvpost.docs.json'
/** Documento-fonte quando o modelo não diz outro. */
export const DEFAULT_DOCS_SOURCE = 'docs/projeto.md'

const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_LOGO_BYTES = 1024 * 1024
/** Inclusões dentro de inclusões: passou disso, é quase certo um ciclo longo. */
const MAX_INCLUDE_DEPTH = 8

export interface DocsProject {
  /** O modelo lido (vazio quando o arquivo não existe ou é inválido). */
  config: DocsConfig
  configExists: boolean
  /** Problemas do vvpost.docs.json: com eles, vale o modelo vazio. */
  configIssues: { file: string; message: string }[]
  /** Documento-fonte, relativo ao workspace. */
  sourceFile: string
  /** Texto do documento-fonte; null quando ainda não existe. */
  source: string | null
}

/** Lê o modelo e o documento-fonte do projeto. Nada aqui falha por arquivo ausente. */
export async function loadDocsProject(dir: string): Promise<DocsProject> {
  const configIssues: DocsProject['configIssues'] = []
  let config: DocsConfig = {}
  let configExists = false
  let text: string | null = null
  try {
    text = await readFile(resolve(dir, DOCS_CONFIG_FILE), 'utf8')
    configExists = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') configIssues.push({ file: DOCS_CONFIG_FILE, message: (err as Error).message })
  }
  if (text !== null) {
    try {
      const result = validateDocsConfig(JSON.parse(text))
      if (result.ok) config = result.value
      else for (const i of result.issues) configIssues.push({ file: DOCS_CONFIG_FILE, message: `${i.path || '/'}: ${i.message}` })
    } catch (err) {
      configIssues.push({ file: DOCS_CONFIG_FILE, message: `JSON inválido (${(err as Error).message})` })
    }
  }
  const sourceFile = normalizeRel(config.source ?? DEFAULT_DOCS_SOURCE)
  let source: string | null = null
  try {
    source = await readWorkspaceText(dir, sourceFile)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') configIssues.push({ file: sourceFile, message: (err as Error).message })
  }
  return { config, configExists, configIssues, sourceFile, source }
}

/** Documento-fonte de partida, quando o projeto ainda não tem um (editor, vvpost docs init, MCP). */
export const DOCS_STARTER_SOURCE = `## Visão geral

Escreva aqui o que a API faz, para quem ela existe e como começar. Tudo o que está entre
\`{{> ... }}\` é montado a partir do projeto: digite \`{{>\` no editor para ver as opções, ou use **Inserir**.

{{> summary}}

{{> map}}

## Ambientes

{{> environments}}

{{> variables}}

## Referência

{{> reference}}
`

/** Modelo validado pelo schema docs.json; erro com todos os problemas. */
export function parseDocsConfig(config: unknown): DocsConfig {
  const result = validateDocsConfig(config ?? {})
  if (!result.ok) throw new DocsError(`modelo inválido: ${result.issues.map((i) => `${i.path || '/'} ${i.message}`).join('; ')}`)
  return result.value
}

/**
 * Grava o modelo (vvpost.docs.json, com o $schema) e o documento-fonte, para o app, o CLI e o
 * MCP. Os dois vão para o Git: nada com valor de segredo do workspace é gravado, e nenhum
 * caminho sai do workspace.
 */
export async function writeDocsProject(ws: LoadedWorkspace, draft: { config: unknown; source: string }): Promise<{ files: string[]; config: DocsConfig }> {
  const config = parseDocsConfig(draft.config)
  if (typeof draft.source !== 'string') throw new DocsError('o documento-fonte precisa ser texto')
  if (Buffer.byteLength(draft.source) > MAX_SOURCE_BYTES) throw new DocsError('o documento passa de 1 MB')
  const { $schema: _schema, ...fields } = config
  const json = `${JSON.stringify({ $schema: SchemaId.Docs, ...fields }, null, 2)}\n`
  const sanitizer = createSecretSanitizer()
  sanitizer.addWorkspace(ws)
  if (sanitizer.leaks(draft.source) || sanitizer.leaks(json)) throw new DocsError('o documento tem o valor de um segredo do workspace; nada foi gravado')
  const sourceFile = normalizeRel(config.source ?? DEFAULT_DOCS_SOURCE)
  const [configPath, sourcePath] = await Promise.all([workspaceWritePath(ws.dir, DOCS_CONFIG_FILE), workspaceWritePath(ws.dir, sourceFile)])
  await writeFile(configPath, json)
  await writeFile(sourcePath, draft.source.endsWith('\n') ? draft.source : `${draft.source}\n`)
  return { files: [DOCS_CONFIG_FILE, sourceFile], config }
}

/**
 * Uma página de documentação do projeto (docs/**.md): visão geral, arquitetura, guias. O
 * documento do projeto junta as páginas com {{> include docs/pagina.md}}, em vez de .md soltos.
 * Texto vazio apaga a página. Recusa caminho fora de docs/, a doc dos conectores (essa é do
 * conector) e valor de segredo do workspace.
 */
export async function writeDocsPage(ws: LoadedWorkspace, file: string, markdown: string): Promise<{ file: string; deleted: boolean }> {
  const rel = normalizeRel(file)
  if (!/^docs\/.+\.(md|mmd)$/i.test(rel) || rel.startsWith('docs/../')) throw new DocsError(`páginas ficam em docs/ e terminam em .md (ou .mmd, um diagrama) ("${file}")`)
  if (/\.connector\.vvpost\.md$/i.test(rel)) throw new DocsError('a documentação de um conector é escrita no próprio conector')
  if (typeof markdown !== 'string') throw new DocsError('a página precisa ser texto')
  if (Buffer.byteLength(markdown) > MAX_SOURCE_BYTES) throw new DocsError('a página passa de 1 MB')
  const sanitizer = createSecretSanitizer()
  sanitizer.addWorkspace(ws)
  if (sanitizer.leaks(markdown)) throw new DocsError('a página tem o valor de um segredo do workspace; nada foi gravado')
  const path = await workspaceWritePath(ws.dir, rel)
  if (markdown === '') {
    await rm(path, { force: true })
    return { file: rel, deleted: true }
  }
  await writeFile(path, markdown.endsWith('\n') ? markdown : `${markdown}\n`)
  return { file: rel, deleted: false }
}

/**
 * Caminho absoluto de um arquivo do workspace, recusando o que sai dele (absoluto, "..",
 * link simbólico para fora). O documento pode vir de um repositório qualquer.
 */
export async function resolveWorkspaceFile(dir: string, rel: string): Promise<string> {
  if (!rel || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.includes('\0')) throw new DocsError(`caminho inválido "${rel}"`)
  const root = await realpath(dir)
  const target = resolve(root, rel)
  const inside = (path: string) => {
    const r = relative(root, path)
    return r !== '' && !r.startsWith('..') && !isAbsolute(r)
  }
  if (!inside(target)) throw new DocsError(`"${rel}" fica fora do workspace`)
  let real: string
  try {
    real = await realpath(target)
  } catch (err) {
    throw Object.assign(new DocsError(`"${rel}" não existe no workspace`), { code: (err as NodeJS.ErrnoException).code })
  }
  if (!inside(real)) throw new DocsError(`"${rel}" aponta para fora do workspace`)
  return real
}

export async function readWorkspaceText(dir: string, rel: string): Promise<string> {
  const path = await resolveWorkspaceFile(dir, rel)
  const info = await stat(path)
  if (!info.isFile()) throw new DocsError(`"${rel}" não é um arquivo`)
  if (info.size > MAX_SOURCE_BYTES) throw new DocsError(`"${rel}" passa de 1 MB`)
  return readFile(path, 'utf8')
}

const LOGO_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  gif: 'image/gif'
}

/** O logo do modelo como data: URL (a página do PDF não carrega nada de fora). */
export async function readDocsLogo(dir: string, rel: string): Promise<string> {
  const type = LOGO_TYPES[/\.([A-Za-z]+)$/.exec(rel)?.[1]?.toLowerCase() ?? '']
  if (!type) throw new DocsError(`o logo "${rel}" precisa ser PNG, JPEG, SVG, WebP ou GIF`)
  // Num projeto de um workspace, o logo que não está no projeto vem do Compartilhado (a raiz):
  // a marca fica num lugar só e vale para todos os projetos.
  const path = await resolveWorkspaceFile(dir, rel).catch(async (err: DocsError & { code?: string }) => {
    if (err.code !== 'ENOENT' || !isProjectDir(dir)) throw err
    return resolveWorkspaceFile(dirname(resolve(dir)), rel)
  })
  const info = await stat(path)
  if (!info.isFile()) throw new DocsError(`"${rel}" não é um arquivo`)
  if (info.size > MAX_LOGO_BYTES) throw new DocsError(`o logo "${rel}" passa de 1 MB`)
  return `data:${type};base64,${(await readFile(path)).toString('base64')}`
}

/**
 * Onde gravar um arquivo do workspace (o modelo ou o documento-fonte): cria a pasta e recusa o
 * que cairia fora dele, inclusive por link simbólico.
 */
export async function workspaceWritePath(dir: string, rel: string): Promise<string> {
  const clean = normalizeRel(rel)
  if (!clean || clean.startsWith('..') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.includes('\0')) {
    throw new DocsError(`caminho inválido "${rel}"`)
  }
  const root = await realpath(dir)
  const target = resolve(root, clean)
  await mkdir(dirname(target), { recursive: true })
  const parent = await realpath(dirname(target))
  const inside = (path: string) => {
    const r = relative(root, path)
    return r === '' || (!r.startsWith('..') && !isAbsolute(r))
  }
  if (!inside(parent)) throw new DocsError(`"${rel}" fica fora do workspace`)
  const real = await realpath(target).catch(() => target)
  if (!inside(dirname(real)) || real === root) throw new DocsError(`"${rel}" aponta para fora do workspace`)
  return target
}

const IMAGE = /\.(png|jpe?g|svg|webp|gif)$/i
/** Arquivos Markdown lidos para listar as seções; o resto aparece sem seções. */
const MAX_LISTED_MARKDOWN = 300

export interface DocsMarkdownFile {
  file: string
  /** Seções que dá para incluir com {{> include arquivo#id}}. */
  sections: { id: string; title: string; level: number }[]
}

/**
 * Arquivos do workspace que o editor oferece: os Markdown que podem ser incluídos (as docs dos
 * conectores entre eles), com as seções, e as imagens que servem de logo.
 */
export async function listDocsFiles(dir: string): Promise<{ markdown: DocsMarkdownFile[]; images: string[]; diagrams: string[] }> {
  const root = resolve(dir)
  const all = await findFiles(root, '')
  const rel = (path: string) => relative(root, path).split(sep).join('/')
  const markdown: DocsMarkdownFile[] = []
  for (const path of all.filter((f) => /\.md$/i.test(f))) {
    let sections: DocsMarkdownFile['sections'] = []
    if (markdown.length < MAX_LISTED_MARKDOWN) {
      try {
        if ((await stat(path)).size <= MAX_SOURCE_BYTES) sections = markdownSections(await readFile(path, 'utf8'))
      } catch {
        // arquivo sumiu ou sem permissão: entra sem seções
      }
    }
    markdown.push({ file: rel(path), sections })
  }
  return { markdown, images: all.filter((f) => IMAGE.test(f)).map(rel), diagrams: all.filter((f) => /\.mmd$/i.test(f)).map(rel) }
}

/** Títulos de um Markdown com a âncora que o {{> include arquivo#âncora}} aceita. */
export function markdownSections(markdown: string): { id: string; title: string; level: number }[] {
  const slugs = new Map<string, number>()
  return headingsOf(markdown.replace(/\r\n?/g, '\n')).map((h) => {
    const base = slugBase(plainHeading(h.text))
    const n = slugs.get(base) ?? 0
    slugs.set(base, n + 1)
    return { id: h.anchor ?? (n ? `${base}-${n}` : base), title: h.text, level: h.level }
  })
}

export interface DocDiagnostic {
  /** Arquivo do problema, relativo ao workspace. */
  file: string
  line: number
  severity: 'error' | 'warning'
  message: string
}

export interface ComposedDocs {
  title: string
  /** O .md completo: título, sumário e corpo. */
  markdown: string
  /** O que vai para o PDF: o mesmo, sem o bloco de título quando o modelo tem capa (a capa o traz). */
  printMarkdown: string
  diagnostics: DocDiagnostic[]
  /** Arquivos incluídos com {{> include}}. */
  includes: string[]
  /**
   * Com a opção sourceMap: para cada linha do printMarkdown, a linha (a partir de 1) do
   * documento-fonte de onde ela veio; 0 nas linhas que a montagem cria (título, sumário). Um trecho
   * de diretiva (include, conector, endpoint) aponta a linha da diretiva. É o que liga a prévia ao
   * texto, como o data-line da prévia de Markdown do VS Code.
   */
  sourceLines?: number[]
}

export interface ComposeOptions extends GenerateDocsOptions {
  /** Texto do documento-fonte (o do editor, salvo ou não). */
  source: string
  /** Onde o documento-fonte fica, para as mensagens e as inclusões relativas. */
  sourceFile?: string
  config?: DocsConfig
  /**
   * Marca cada diagrama escrito com a origem (`%% vvpost:origem arquivo:linha`, um comentário que o
   * Mermaid ignora), para o app abrir o diagrama no editor e gravar de volta no lugar certo.
   */
  diagramOrigins?: boolean
  /** Devolve o sourceLines (a linha do documento-fonte de cada linha do printMarkdown), para o editor. */
  sourceMap?: boolean
}

/**
 * Um {{> tipo argumento}} sozinho na linha. Os tipos: summary, map, environments, variables,
 * flows, reference, issues, connector <id>, endpoint <conector>/<endpoint>,
 * request <conector>/<endpoint>/<cenário> e include <arquivo.md>[#seção].
 */
const DIRECTIVE = /^\s{0,3}\{\{>\s*([A-Za-z0-9-]+)(?:\s+(.*?))?\s*\}\}\s*$/
const LOOSE_DIRECTIVE = /\{\{>/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const ANCHOR = /\s*\{#([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\s*$/

const MERMAID_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*mermaid\s*$/i

const SIMPLE_KINDS = new Set(['summary', 'map', 'c4', 'environments', 'variables', 'flows', 'reference', 'issues'])

/** Exemplos de cada diretiva, para mensagens de erro e para o autocomplete do editor. */
export const DOC_DIRECTIVES: readonly { kind: string; usage: string; description: string }[] = [
  { kind: 'summary', usage: '{{> summary}}', description: 'Números do projeto: conectores, endpoints, requests, fluxos e ambientes' },
  { kind: 'map', usage: '{{> map}}', description: 'Mapa do projeto (herança, endpoints e fluxos)' },
  { kind: 'c4', usage: '{{> c4}}', description: 'Diagrama C4 de contexto gerado do catálogo: o projeto, os conectores por família e os fluxos que chamam cada um' },
  { kind: 'environments', usage: '{{> environments}}', description: 'Tabela de ambientes' },
  { kind: 'variables', usage: '{{> variables}}', description: 'Variáveis usadas, com o valor por ambiente (segredos só pelo nome)' },
  { kind: 'flows', usage: '{{> flows}}', description: 'Fluxos do projeto' },
  { kind: 'reference', usage: '{{> reference}}', description: 'Referência completa: todos os conectores e endpoints' },
  { kind: 'issues', usage: '{{> issues}}', description: 'Avisos do workspace (arquivos ignorados, herança quebrada)' },
  { kind: 'connector', usage: '{{> connector <id>}}', description: 'Um conector com a herança, a auth e os endpoints' },
  { kind: 'endpoint', usage: '{{> endpoint <conector>/<endpoint>}}', description: 'Um endpoint com headers, corpo, cenários e fluxos' },
  { kind: 'request', usage: '{{> request <conector>/<endpoint>/<cenário>}}', description: 'Uma request (cenário) com overrides e asserções' },
  { kind: 'include', usage: '{{> include <arquivo.md>#<seção>}}', description: 'Trecho de outro Markdown do workspace (a seção pelo título ou {#id})' },
  { kind: 'tokens', usage: '{{> tokens <grupo>}}', description: 'Tokens da marca de brand/*.tokens.json (todos ou só o grupo, ex.: color), com os valores por modo' },
  { kind: 'contrast', usage: '{{> contrast}}', description: 'Pares de contraste da marca em cada modo, com a razão WCAG e se passam' },
  { kind: 'codemap', usage: '{{> codemap <pasta>}}', description: 'Mapa do código: uma linha por área (cada pasta dentro da pasta do repositório) com os arquivos de código dela' },
  { kind: 'diagram', usage: '{{> diagram <arquivo.mmd>}}', description: 'Diagrama Mermaid guardado num arquivo .mmd do workspace (o editor de diagramas cria e edita)' }
]

/**
 * Documento do projeto a partir do documento-fonte em Markdown: o texto escrito, com os
 * trechos gerados ({{> endpoint ...}}, {{> connector ...}}, {{> map}}...) e os trechos de outras
 * docs ({{> include ...}}) no lugar das diretivas, os títulos dos trechos encaixados abaixo do
 * título em que estão, numeração e sumário pelo modelo. Problemas viram diagnósticos com a
 * linha (e um aviso no próprio documento), sem derrubar o resto.
 *
 * Os trechos gerados vêm do mesmo modelo da documentação rica, já sanitizado; o texto final
 * também passa pelo Secret Sanitizer e é recusado se ainda tiver um valor conhecido.
 */
export async function composeDocumentation(
  ws: LoadedWorkspace,
  flows: FlowCatalog,
  options: ComposeOptions
): Promise<ComposedDocs> {
  const config = options.config ?? {}
  const sourceFile = normalizeRel(options.sourceFile ?? config.source ?? DEFAULT_DOCS_SOURCE)
  // O documento gerado do projeto inteiro: todo trecho sai dele.
  const generated = await generateDocumentation(ws, flows, { kind: 'project' }, options)
  const doc = generated.document
  const diagnostics: DocDiagnostic[] = []
  const includes = new Set<string>()

  let brand: Promise<import('../brand/load').BrandLoad> | undefined
  const origin = (file: string, line?: number) => `${DIAGRAM_ORIGIN}${file}${line ? `:${line}` : ''}`
  /** offset: linhas antes do trecho no arquivo (uma seção incluída), para a origem dos diagramas. */
  const expand = async (
    text: string,
    file: string,
    stack: string[],
    baseLevel: number,
    offset = 0,
    track?: (index: number, line: number) => void
  ): Promise<string[]> => {
    const out: string[] = []
    let fence: string | null = null
    // Nível do último título: o trecho incluído fica abaixo dele.
    let context = baseLevel
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    let mermaid: { line: number; lines: string[] } | null = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      // O que sai daqui até a próxima linha veio desta linha do documento-fonte.
      track?.(out.length, i + 1)
      const f = FENCE.exec(line)
      if (fence) {
        if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) {
          fence = null
          // Diagrama escrito que não cabe numa página: o aviso aponta a linha dele.
          const big = mermaid && oversizedDiagram(mermaid.lines.join('\n'))
          if (big) problem(file, mermaid!.line, 'warning', big, out, false)
          mermaid = null
        } else mermaid?.lines.push(line)
        out.push(line)
        continue
      }
      if (f) {
        fence = f[1]!
        if (MERMAID_FENCE.test(line)) mermaid = { line: offset + i + 1, lines: [] }
        out.push(line)
        if (options.diagramOrigins && MERMAID_FENCE.test(line)) out.push(origin(file, offset + i + 1))
        continue
      }
      const h = HEADING.exec(line)
      if (h) {
        context = h[1]!.length
        out.push(line)
        continue
      }
      const d = DIRECTIVE.exec(line)
      if (!d) {
        if (LOOSE_DIRECTIVE.test(line) && !/`[^`]*\{\{>/.test(line)) {
          problem(file, i + 1, 'warning', 'diretiva {{> ...}} precisa ficar sozinha na linha; o texto ficou como está', out, false)
        }
        out.push(line)
        continue
      }
      const kind = d[1]!.toLowerCase()
      const arg = (d[2] ?? '').trim()
      const target = Math.min(6, Math.max(2, context + 1))
      try {
        if (kind === 'include') {
          const piece = await include(arg, file, stack)
          out.push(...(await expand(shiftHeadings(piece.text, target), piece.file, [...stack, piece.key], target - 1, piece.offset)))
          continue
        }
        if (kind === 'diagram') {
          const rel = diagramPath(arg, file)
          const code = await readDiagramText(rel)
          includes.add(rel)
          const big = oversizedDiagram(code)
          if (big) problem(rel, 1, 'warning', big, out, false)
          out.push('', '```mermaid', ...(options.diagramOrigins ? [origin(rel)] : []), code.replace(/\s+$/, ''), '```', '')
          continue
        }
        if (kind === 'codemap') {
          const { CodeMapError, readCodeMap, renderCodeMapMarkdown, repoRoot } = await import('./codemap')
          if (!arg) throw new DocsError(`codemap precisa da pasta: ${usage('codemap')}`)
          try {
            const areas = await readCodeMap(repoRoot(ws.root ?? ws.dir), arg)
            if (!areas.length) throw new DocsError(`nenhuma área com código em "${arg}"`)
            out.push('', renderCodeMapMarkdown(areas), '')
          } catch (err) {
            if (err instanceof CodeMapError) throw new DocsError(err.message)
            throw err
          }
          continue
        }
        if (kind === 'tokens' || kind === 'contrast') {
          const { renderContrastMarkdown, renderTokensMarkdown } = await import('../brand/markdown')
          brand ??= (await import('../brand/load')).loadBrand(ws.dir, ws.root ? { root: ws.root } : {})
          const { files } = await brand
          for (const f of files) includes.add(f.file)
          const md = kind === 'tokens' ? renderTokensMarkdown(files, arg) : renderContrastMarkdown(files)
          if (md === null) {
            throw new DocsError(
              !files.length
                ? `${kind} precisa de um arquivo brand/<nome>.tokens.json no projeto (docs/brand.md)`
                : kind === 'tokens'
                  ? `nenhum token${arg ? ` no grupo "${arg}"` : ''} nos arquivos de brand/`
                  : 'nenhum par em $extensions.vvpost.contrast nos arquivos de brand/'
            )
          }
          out.push('', md, '')
          continue
        }
        const fragment = parseFragment(kind, arg)
        const md = renderDocFragment(doc, fragment)
        if (md === null) throw new DocsError(missing(fragment))
        if (md) out.push('', shiftHeadings(md, target), '')
      } catch (err) {
        if (!(err instanceof DocsError)) throw err
        problem(file, i + 1, 'error', err.message, out, true)
      }
    }
    return out
  }

  const problem = (file: string, line: number, severity: DocDiagnostic['severity'], message: string, out: string[], inline: boolean) => {
    diagnostics.push({ file, line, severity, message })
    if (inline) out.push('', `> ⚠️ **${escapeText(file)}:${line}** ${escapeText(message)}`, '')
  }

  const include = async (arg: string, from: string, stack: string[]) => {
    if (!arg) throw new DocsError(`include precisa do arquivo: ${usage('include')}`)
    const hash = arg.indexOf('#')
    const path = hash < 0 ? arg : arg.slice(0, hash)
    const section = hash < 0 ? '' : arg.slice(hash + 1).trim()
    if (!/\.md$/i.test(path)) throw new DocsError(`include aceita só arquivos .md ("${path}")`)
    // Relativo à raiz do workspace; "./x.md" e "../x.md" relativos ao arquivo que inclui.
    const rel = path.startsWith('./') || path.startsWith('../') ? normalizeRel(`${from.split('/').slice(0, -1).join('/')}/${path}`) : normalizeRel(path)
    if (rel.startsWith('../') || rel === '..') throw new DocsError(`"${path}" fica fora do workspace`)
    const key = `${rel}#${section}`
    if (stack.includes(key) || (rel === sourceFile && !section)) throw new DocsError(`inclusão circular de "${arg}"`)
    if (stack.length >= MAX_INCLUDE_DEPTH) throw new DocsError(`mais de ${MAX_INCLUDE_DEPTH} inclusões aninhadas`)
    let text: string
    try {
      text = rel === sourceFile ? options.source : await readWorkspaceText(ws.dir, rel)
    } catch (err) {
      if (err instanceof DocsError) throw err
      throw new DocsError(`não deu para ler "${rel}": ${(err as Error).message}`)
    }
    includes.add(rel)
    const body = section ? sectionOf(text, section) : { text, start: 0 }
    if (body === null) throw new DocsError(`seção "${section}" não existe em "${rel}"`)
    return { text: body.text, file: rel, key, offset: body.start }
  }

  const diagramPath = (arg: string, from: string) => {
    if (!arg) throw new DocsError(`diagram precisa do arquivo: ${usage('diagram')}`)
    if (!/\.mmd$/i.test(arg)) throw new DocsError(`diagram aceita só arquivos .mmd ("${arg}")`)
    const rel = arg.startsWith('./') || arg.startsWith('../') ? normalizeRel(`${from.split('/').slice(0, -1).join('/')}/${arg}`) : normalizeRel(arg)
    if (rel.startsWith('../') || rel === '..') throw new DocsError(`"${arg}" fica fora do workspace`)
    return rel
  }
  const readDiagramText = async (rel: string) => {
    try {
      return await readWorkspaceText(ws.dir, rel)
    } catch (err) {
      if (err instanceof DocsError) throw err
      throw new DocsError(`não deu para ler "${rel}": ${(err as Error).message}`)
    }
  }

  const marks: [number, number][] = []
  const pieces = await expand(options.source, sourceFile, [`${sourceFile}#`], 0, 0, options.sourceMap ? (index, line) => marks.push([index, line]) : undefined)
  const body = pieces.join('\n')
  const numbered = config.numberHeadings ? numberHeadings(body) : body
  const title = config.title || `Documentação de ${doc.project.name}`
  const titleBlock = renderTitleBlock(title, config, doc)
  const withToc = (prefix: string[]) => {
    if (config.toc === false) return numbered
    const toc = renderToc(numbered, prefix)
    return toc ? `${toc}\n\n${numbered}` : numbered
  }
  const finish = (text: string) => `${text.replace(/\n{3,}/g, '\n\n').trim()}\n`

  const markdownRaw = finish(`${titleBlock}\n\n${withToc([title])}`)
  const printRaw = config.cover === false ? markdownRaw : finish(withToc([]))

  // Documentação é prosa: "Authorization: Bearer" num parágrafo não é credencial (formatos e valores do workspace seguem valendo).
  const sanitizer = createSecretSanitizer({ prose: true })
  sanitizer.addWorkspace(ws)
  const markdown = sanitizer.sanitize(markdownRaw)
  const printMarkdown = sanitizer.sanitize(printRaw)
  if (sanitizer.leaks(markdown) || sanitizer.leaks(printMarkdown)) {
    throw new DocsError('a documentação teria o valor de uma credencial; nada foi gerado')
  }
  if (markdown !== markdownRaw) {
    diagnostics.push({ file: sourceFile, line: 1, severity: 'warning', message: 'o texto tinha valores com cara de segredo; saíram mascarados no documento' })
  }
  const sourceLines = options.sourceMap ? mapSourceLines(pieces, marks, printMarkdown) : undefined
  return { title, markdown, printMarkdown, diagnostics, includes: [...includes], ...(sourceLines && { sourceLines }) }
}

/**
 * A linha do documento-fonte de cada linha do texto final. pieces são os pedaços que a montagem
 * produziu (um pedaço pode ter várias linhas: um trecho gerado) e marks, onde começa o que cada
 * linha do fonte produziu. Depois da montagem vêm a numeração dos títulos, o sumário, a junção das
 * linhas em branco e o sanitizer: nenhum deles cria nem tira linha com texto, então as linhas com
 * texto do corpo são as últimas do texto final, na mesma ordem. As linhas em branco ficam com a
 * linha da anterior. Sem essa correspondência (não deveria acontecer), não há mapa.
 */
function mapSourceLines(pieces: string[], marks: [number, number][], final: string): number[] | undefined {
  const bodyLines: number[] = []
  let m = 0
  let current = 0
  pieces.forEach((piece, index) => {
    while (m < marks.length && marks[m]![0] <= index) current = marks[m++]![1]
    for (const line of piece.split('\n')) if (line.trim()) bodyLines.push(current)
  })
  const lines = final.split('\n')
  const filled = lines.filter((l) => l.trim()).length
  const extra = filled - bodyLines.length
  if (extra < 0) return undefined
  let seen = 0
  let last = 0
  return lines.map((line) => {
    if (!line.trim()) return last
    seen++
    last = seen <= extra ? 0 : bodyLines[seen - extra - 1]!
    return last
  })
}

/** Nós de um fluxograma a partir dos quais ele não cabe numa página do PDF sem dividir em etapas. */
const MAX_DIAGRAM_NODES = 24

/**
 * Fluxograma escrito grande demais e sem etapas: o PDF divide por subgraph de primeiro nível, um
 * diagrama por etapa; sem etapas, o diagrama é cortado entre páginas. O aviso diz como resolver.
 * Os diagramas gerados pelo VVPost (mapa, herança) não passam por aqui.
 */
function oversizedDiagram(text: string): string | null {
  if (!/^\s*(flowchart|graph)\b/m.test(text)) return null
  const nodes = new Set([...text.matchAll(/\b([A-Za-z_]\w*)\s*(?:\(\[|\[\[|\[\(|\(\(|\{\{|\[|\(|\{)/g)].map((n) => n[1]))
  nodes.delete('subgraph')
  let depth = 0
  let steps = 0
  let loose = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (/^subgraph\b/.test(t)) {
      if (depth === 0) steps++
      depth++
    } else if (t === 'end') depth--
    else if (depth === 0 && t && !/^(flowchart|graph|classDef|class|style|linkStyle|click|%%)/.test(t)) loose = true
  }
  if (nodes.size <= MAX_DIAGRAM_NODES || (steps >= 2 && !loose)) return null
  return `fluxograma com ${nodes.size} nós não cabe numa página do PDF: divida em etapas (um subgraph de primeiro nível por etapa, sem nós fora delas), e o PDF sai com um diagrama por etapa`
}

function usage(kind: string): string {
  return DOC_DIRECTIVES.find((d) => d.kind === kind)?.usage ?? ''
}

function parseFragment(kind: string, arg: string): DocFragment {
  if (SIMPLE_KINDS.has(kind)) {
    if (arg) throw new DocsError(`${usage(kind)} não leva argumento`)
    return { kind } as DocFragment
  }
  const parts = (n: number) => {
    // Ids de conector podem ter pontos, não barras: o resto da linha separa pelas últimas barras.
    const pieces = arg.split('/')
    if (!arg || pieces.length < n || pieces.some((p) => !p.trim())) throw new DocsError(`use ${usage(kind)}`)
    const tail = pieces.slice(pieces.length - (n - 1)).map((p) => p.trim())
    return [pieces.slice(0, pieces.length - (n - 1)).join('/').trim(), ...tail]
  }
  switch (kind) {
    case 'connector':
      if (!arg) throw new DocsError(`use ${usage(kind)}`)
      return { kind, connectorId: arg }
    case 'endpoint': {
      const [connectorId, endpointId] = parts(2)
      return { kind, connectorId: connectorId!, endpointId: endpointId! }
    }
    case 'request': {
      const [connectorId, endpointId, scenarioId] = parts(3)
      return { kind, connectorId: connectorId!, endpointId: endpointId!, scenarioId: scenarioId! }
    }
    default:
      throw new DocsError(`diretiva desconhecida "${kind}"; use ${DOC_DIRECTIVES.map((d) => d.kind).join(', ')}`)
  }
}

function missing(f: DocFragment): string {
  if (f.kind === 'connector') return `conector "${f.connectorId}" não existe no workspace`
  if (f.kind === 'endpoint') return `endpoint "${f.connectorId}/${f.endpointId}" não existe no workspace`
  if (f.kind === 'request') return `request "${f.connectorId}/${f.endpointId}/${f.scenarioId}" não existe no workspace`
  return `trecho "${f.kind}" indisponível`
}

/** Junta a/./b/../c em a/c; um ".." que sobra fica no começo. */
export function normalizeRel(path: string): string {
  const out: string[] = []
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/**
 * Uma seção de um Markdown: o título com o {#id} ou com o slug pedido e tudo até o próximo
 * título do mesmo nível ou acima. null: não achou.
 */
export function extractSection(markdown: string, section: string): string | null {
  return sectionOf(markdown, section)?.text ?? null
}

/** A seção e a linha (a partir de 0) em que ela começa no arquivo. */
function sectionOf(markdown: string, section: string): { text: string; start: number } | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const want = section.trim().toLowerCase()
  let fence: string | null = null
  let start = -1
  let level = 0
  const slugs = new Map<string, number>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const f = FENCE.exec(line)
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null
      continue
    }
    if (f) {
      fence = f[1]!
      continue
    }
    const h = HEADING.exec(line)
    if (!h) continue
    if (start >= 0) {
      if (h[1]!.length <= level) return { text: lines.slice(start, i).join('\n').trim(), start }
      continue
    }
    const id = ANCHOR.exec(h[2]!)?.[1]
    const base = slugBase(h[2]!.replace(ANCHOR, ''))
    const n = slugs.get(base) ?? 0
    slugs.set(base, n + 1)
    if (id?.toLowerCase() === want || (n ? `${base}-${n}` : base) === want) {
      start = i
      level = h[1]!.length
    }
  }
  return start >= 0 ? { text: lines.slice(start).join('\n').trim(), start } : null
}

/** Leva o título mais alto do trecho para `top`, os outros juntos; tira os {#id} dos títulos. */
export function shiftHeadings(markdown: string, top: number): string {
  const lines = markdown.split('\n')
  let fence: string | null = null
  const levels: number[] = []
  for (const line of lines) {
    const f = FENCE.exec(line)
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null
      continue
    }
    if (f) fence = f[1]!
    else {
      const h = HEADING.exec(line)
      if (h) levels.push(h[1]!.length)
    }
  }
  if (!levels.length) return markdown
  const shift = top - Math.min(...levels)
  fence = null
  return lines
    .map((line) => {
      const f = FENCE.exec(line)
      if (fence) {
        if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null
        return line
      }
      if (f) {
        fence = f[1]!
        return line
      }
      const h = HEADING.exec(line)
      if (!h) return line
      const level = Math.min(6, Math.max(1, h[1]!.length + shift))
      return `${'#'.repeat(level)} ${h[2]!.replace(ANCHOR, '')}`
    })
    .join('\n')
}

/** Títulos fora de blocos de código, na ordem. */
function headingsOf(markdown: string): { level: number; text: string; index: number; anchor?: string }[] {
  const out: { level: number; text: string; index: number; anchor?: string }[] = []
  let fence: string | null = null
  markdown.split('\n').forEach((line, index) => {
    const f = FENCE.exec(line)
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null
      return
    }
    if (f) {
      fence = f[1]!
      return
    }
    const h = HEADING.exec(line)
    if (!h) return
    const anchor = ANCHOR.exec(h[2]!)?.[1]
    out.push({ level: h[1]!.length, text: h[2]!.replace(ANCHOR, ''), index, ...(anchor && { anchor }) })
  })
  return out
}

/** Texto de um título como o leitor o vê (links e imagens pelo texto), para a âncora. */
function plainHeading(text: string): string {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
}

/** 1, 1.1, 1.1.1 nos três primeiros níveis abaixo do título do documento. */
function numberHeadings(markdown: string): string {
  const headings = headingsOf(markdown).filter((h) => h.level >= 2)
  if (!headings.length) return markdown
  const base = Math.min(...headings.map((h) => h.level))
  const counters = [0, 0, 0]
  const lines = markdown.split('\n')
  for (const h of headings) {
    const depth = h.level - base
    if (depth > 2) continue
    counters[depth]!++
    for (let d = depth + 1; d < 3; d++) counters[d] = 0
    const number = counters.slice(0, depth + 1).join('.')
    lines[h.index] = `${'#'.repeat(h.level)} ${number}${depth === 0 ? '.' : ''} ${h.text}`
  }
  return lines.join('\n')
}

/**
 * Sumário com os dois primeiros níveis de títulos e as âncoras do GitHub (as mesmas ids que a
 * prévia e o PDF dão aos títulos). `before`: títulos que vêm antes no arquivo (o do documento).
 */
function renderToc(markdown: string, before: string[]): string {
  const headings = headingsOf(markdown).filter((h) => h.level >= 2)
  if (headings.length < 2) return ''
  const base = Math.min(...headings.map((h) => h.level))
  const slugs = new Map<string, number>()
  const slug = (text: string) => {
    const b = slugBase(plainHeading(text))
    const n = slugs.get(b) ?? 0
    slugs.set(b, n + 1)
    return n ? `${b}-${n}` : b
  }
  for (const t of before) slug(t)
  slug('Sumário')
  const items: string[] = []
  for (const h of headings) {
    const anchor = slug(h.text)
    if (h.level - base > 1) continue
    items.push(`${'  '.repeat(h.level - base)}- [${plainHeading(h.text).replace(/[[\]]/g, '\\$&')}](#${anchor})`)
  }
  return ['## Sumário', '', ...items].join('\n')
}

function renderTitleBlock(title: string, config: DocsConfig, doc: ApiDocument): string {
  const out = [`# ${escapeText(title)}`, '']
  if (config.subtitle) out.push(`_${escapeText(config.subtitle)}_`, '')
  const meta = [config.organization, config.version && `versão ${config.version}`, doc.generatedAt.slice(0, 10)].filter(Boolean)
  out.push(`> ${meta.map((m) => escapeText(m as string)).join(' · ')}`)
  return out.join('\n')
}

function escapeText(text: string): string {
  return text.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/[\r\n]+/g, ' ')
}
