import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { PublishNode, PublishTarget } from '@vvpost/schemas'
import type { LoadedWorkspace } from '../../connectors/workspace'
import { createSecretSanitizer } from '../../sanitizer'
import type { FlowCatalog } from '../../types'
import { DocsError, generateDocumentation, type GenerateDocsOptions } from '../build'
import {
  composeDocumentation,
  extractSection,
  listDocsFiles,
  loadDocsProject,
  markdownSections,
  normalizeRel,
  readWorkspaceText,
  resolveWorkspaceFile,
  shiftHeadings,
  type DocDiagnostic
} from '../compose'
import { renderDocFragment, slugBase } from '../markdown'
import type { ApiDocument } from '../model'
import { PUBLISH_CONFIG_FILE } from './config'
import { markdownToBlocks } from './blocks'
import type { PublishApiEndpoint, PublishAsset, PublishBlock, PublishBundle, PublishInline, PublishMeta, PublishTreeNode } from './types'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_PAGES = 1000
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

/** O conteúdo de uma página, antes de virar Markdown. */
type Source =
  | { kind: 'document' }
  | { kind: 'file'; file: string; section?: string }
  | { kind: 'connector'; connectorId: string; withEndpoints: boolean }
  | { kind: 'endpoint'; connectorId: string; endpointId: string }

interface Resolved {
  key: string
  kind: 'folder' | 'page'
  title: string
  label?: string
  source?: Source
  children: Resolved[]
}

export interface BuiltBundle {
  bundle: PublishBundle
  diagnostics: DocDiagnostic[]
}

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

/**
 * Monta o pacote do "Enviar para…" de um destino: resolve a estrutura (pastas, páginas, globs de
 * .md e uma página por conector), gera o Markdown de cada página com as diretivas expandidas, já
 * pelo Secret Sanitizer, e converte para a árvore neutra com links entre páginas, imagens do
 * workspace e diagramas como anexos. Os diagramas ficam sem imagem: quem tem o Mermaid (o
 * renderer) as desenha antes do plano. Problemas viram diagnósticos sem derrubar o resto.
 */
export async function buildPublishBundle(
  ws: LoadedWorkspace,
  flows: FlowCatalog,
  target: PublishTarget,
  options: GenerateDocsOptions = {}
): Promise<BuiltBundle> {
  const diagnostics: DocDiagnostic[] = []
  const warn = (message: string, file = PUBLISH_CONFIG_FILE, severity: DocDiagnostic['severity'] = 'error') =>
    diagnostics.push({ file, line: 1, severity, message })
  const [generated, project, files] = await Promise.all([
    generateDocumentation(ws, flows, { kind: 'project' }, options),
    loadDocsProject(ws.dir),
    listDocsFiles(ws.dir)
  ])
  const doc = generated.document
  const markdownFiles = files.markdown.map((f) => f.file)

  // 1. Estrutura → árvore com as chaves.
  const keys = new Set<string>()
  let pages = 0
  const claim = (key: string, title: string): boolean => {
    if (keys.has(key)) {
      warn(`"${title}" repete a chave "${key}" (a mesma origem em dois lugares?); ficou de fora`)
      return false
    }
    if (++pages > MAX_PAGES) {
      if (pages === MAX_PAGES + 1) warn(`a estrutura passa de ${MAX_PAGES} páginas; o resto ficou de fora`)
      return false
    }
    keys.add(key)
    return true
  }
  const resolve = (nodes: PublishNode[], path: string[]): Resolved[] => {
    const out: Resolved[] = []
    for (const node of nodes) {
      if ('folder' in node) {
        const key = node.key ?? `folder:${[...path, node.folder].map(slugBase).join('/')}`
        if (claim(key, node.folder)) out.push({ key, kind: 'folder', title: node.folder, children: resolve(node.children ?? [], [...path, node.folder]) })
      } else if ('page' in node) {
        const parsed = node.source ? parseSource(node.source, doc, markdownFiles) : null
        if (parsed && 'error' in parsed) {
          warn(`"${node.page}": ${parsed.error}`)
          continue
        }
        const key = node.key ?? (parsed ? sourceKey(parsed) : `page:${[...path, node.page].map(slugBase).join('/')}`)
        if (claim(key, node.page)) {
          out.push({
            key,
            kind: 'page',
            title: node.page,
            ...(node.source && { label: node.source }),
            ...(parsed && { source: parsed }),
            children: resolve(node.children ?? [], [...path, node.page])
          })
        }
      } else if ('pages' in node) {
        const re = globToRegExp(normalizeRel(node.pages))
        const matched = markdownFiles.filter((f) => re.test(f) && f !== project.sourceFile).sort((a, b) => a.localeCompare(b))
        if (!matched.length) warn(`"${node.pages}" não encontrou nenhum .md`, PUBLISH_CONFIG_FILE, 'warning')
        for (const file of matched) {
          const key = `file:${file}`
          if (keys.has(key)) continue // o mesmo arquivo já tem lugar próprio na estrutura
          const title = fileTitle(node.title ?? '{{heading}}', file, files.markdown.find((f) => f.file === file)?.sections[0]?.title)
          if (claim(key, title)) out.push({ key, kind: 'page', title, label: file, source: { kind: 'file', file }, children: [] })
        }
      } else {
        const ids = node.connectors ?? [...doc.connectors].sort((a, b) => a.name.localeCompare(b.name)).map((c) => c.id)
        for (const id of ids) {
          const c = doc.connectors.find((x) => x.id === id)
          if (!c) {
            warn(`conector "${id}" não existe no projeto`)
            continue
          }
          const key = `connector:${c.id}`
          if (keys.has(key)) continue
          const title = (node.title ?? '{{name}}').replaceAll('{{name}}', c.name).replaceAll('{{id}}', c.id)
          const split = node.split === 'endpoints'
          if (!claim(key, title)) continue
          const children: Resolved[] = []
          if (split) {
            for (const e of c.endpoints) {
              const ek = `endpoint:${c.id}/${e.id}`
              const et = `${e.method} ${e.path} · ${e.name}`
              if (claim(ek, et)) children.push({ key: ek, kind: 'page', title: et, label: `${c.id}/${e.id}`, source: { kind: 'endpoint', connectorId: c.id, endpointId: e.id }, children: [] })
            }
          }
          out.push({ key, kind: 'page', title, label: `connector:${c.id}`, source: { kind: 'connector', connectorId: c.id, withEndpoints: !split }, children })
        }
      }
    }
    return out
  }
  const tree = resolve(target.structure, [])

  // Arquivo publicado como página inteira → chave, para os links entre páginas.
  const fileKeys = new Map<string, string>()
  const walk = (nodes: Resolved[], fn: (n: Resolved) => void) => nodes.forEach((n) => (fn(n), walk(n.children, fn)))
  walk(tree, (n) => {
    if (n.source?.kind === 'file' && !n.source.section) fileKeys.set(n.source.file, n.key)
    if (n.source?.kind === 'document') fileKeys.set(project.sourceFile, n.key)
  })

  // 2. Conteúdo de cada página. Tudo o que sai (títulos, texto, imagens) passa pelo sanitizer.
  const sanitizer = createSecretSanitizer({ prose: true })
  sanitizer.addWorkspace(ws)
  // O título de um glob vem do primeiro título do arquivo, que a pessoa escreveu.
  walk(tree, (n) => void (n.title = sanitizer.text(n.title)))
  const clean = (markdown: string) => {
    const text = sanitizer.text(markdown)
    if (sanitizer.leaks(text)) throw new DocsError('a página teria o valor de uma credencial')
    return text
  }
  const assets = new Map<string, PublishAsset>()
  const imageReads = new Map<string, Promise<void>>()
  const pageMarkdown = async (n: Resolved): Promise<{ markdown: string; file: string; toc: boolean } | null> => {
    const s = n.source!
    if (s.kind === 'document') {
      if (project.source === null) {
        warn(`"${n.title}": o documento do projeto (${project.sourceFile}) ainda não existe`)
        return null
      }
      const composed = await composeDocumentation(ws, flows, {
        ...options,
        source: project.source,
        sourceFile: project.sourceFile,
        config: { ...project.config, cover: true, toc: false }
      })
      diagnostics.push(...composed.diagnostics)
      return { markdown: clean(composed.printMarkdown), file: project.sourceFile, toc: project.config.toc !== false }
    }
    if (s.kind === 'file') {
      let text = await readWorkspaceText(ws.dir, s.file)
      if (s.section) {
        const section = extractSection(text, s.section)
        if (section === null) throw new DocsError(`seção "${s.section}" não existe em "${s.file}"`)
        text = section
      }
      const composed = await composeDocumentation(ws, flows, { ...options, source: text, sourceFile: s.file, config: { cover: true, toc: false } })
      diagnostics.push(...composed.diagnostics)
      return { markdown: clean(dropTitle(composed.printMarkdown, n.title)), file: s.file, toc: false }
    }
    const view = viewFor(doc, s)
    const md = renderDocFragment(view, s.kind === 'connector' ? { kind: 'connector', connectorId: s.connectorId } : { kind: 'endpoint', connectorId: s.connectorId, endpointId: s.endpointId })
    if (md === null) throw new DocsError(`${s.kind === 'connector' ? `conector "${s.connectorId}"` : `endpoint "${s.connectorId}/${s.endpointId}"`} não existe no projeto`)
    return { markdown: clean(dropTitle(md, null)), file: ws.connectorFiles.get(s.connectorId) ?? PUBLISH_CONFIG_FILE, toc: false }
  }

  const build = async (n: Resolved): Promise<PublishTreeNode> => {
    const children: PublishTreeNode[] = []
    for (const c of n.children) children.push(await build(c))
    if (n.kind === 'folder' || !n.source) {
      return { key: n.key, kind: n.kind, title: n.title, hash: sha(JSON.stringify([n.kind, n.title])), children }
    }
    let content: Awaited<ReturnType<typeof pageMarkdown>> = null
    try {
      content = await pageMarkdown(n)
    } catch (err) {
      if (!(err instanceof DocsError)) throw err
      warn(`"${n.title}": ${err.message}`)
    }
    if (!content) return { key: n.key, kind: 'page', title: n.title, ...(n.label && { source: n.label }), hash: sha(JSON.stringify(['page', n.title])), children }
    const used = new Set<string>()
    const images: Promise<void>[] = []
    const blocks = markdownToBlocks(content.markdown, {
      link: (href) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return { href }
        if (href.startsWith('#')) return { anchor: href.slice(1) }
        const [path = '', anchor] = href.split('#')
        // Como no GitHub, relativo ao arquivo; como nas diretivas, relativo à raiz do workspace.
        const page = fileKeys.get(fromFile(content!.file, path)) ?? fileKeys.get(normalizeRel(path))
        return page ? { page, ...(anchor && { anchor }) } : { href }
      },
      image: (src) => {
        if (/^https?:\/\//i.test(src)) return { url: src }
        const ext = /\.([A-Za-z]+)$/.exec(src.split(/[?#]/)[0]!)?.[1]?.toLowerCase() ?? ''
        const type = IMAGE_TYPES[ext]
        if (!type || src.startsWith('data:')) return null
        const local = fromFile(content!.file, src)
        const rel = src.startsWith('./') || src.startsWith('../') || files.images.includes(local) ? local : normalizeRel(src)
        const id = `vv-imagem-${sha(rel).slice(0, 12)}.${ext}`
        used.add(id)
        if (!imageReads.has(id)) {
          const asset: PublishAsset = { id, mediaType: type, hash: '', file: rel }
          assets.set(id, asset)
          imageReads.set(
            id,
            readImage(ws.dir, rel, (data) => sanitizer.leaks(Buffer.from(data).toString('latin1'))).then(
              (data) => {
                asset.data = data
                asset.hash = sha(data)
              },
              (err: Error) => {
                assets.delete(id)
                warn(`"${n.title}": imagem "${src}": ${err.message}`, content!.file, 'warning')
              }
            )
          )
        }
        images.push(imageReads.get(id)!)
        return { asset: id }
      },
      diagram: (source) => {
        const format = diagramFormat(target)
        const hash = sha(`${format}\n${source}`)
        const id = `vv-diagrama-${hash.slice(0, 12)}.${format === 'svg' ? 'svg' : 'png'}`
        used.add(id)
        if (!assets.has(id)) assets.set(id, { id, mediaType: format === 'svg' ? 'image/svg+xml' : 'image/png', hash, diagram: source })
        return id
      }
    })
    await Promise.all(images)
    // Imagem que não deu para ler (ou recusada) vira o texto alternativo.
    withoutMissingImages(blocks, (id) => assets.has(id))
    const ids = [...used].filter((id) => assets.has(id)).sort()
    const hash = sha(JSON.stringify(['page', n.title, content.toc, blocks, ids.map((id) => assets.get(id)!.hash)]))
    return {
      key: n.key,
      kind: 'page',
      title: n.title,
      ...(n.label && { source: n.label }),
      page: { markdown: content.markdown, blocks, toc: content.toc },
      hash,
      children
    }
  }

  const nodes: PublishTreeNode[] = []
  for (const n of tree) nodes.push(await build(n))

  // Para os exportadores: os endpoints com o hash da referência (o histórico de mudanças) e a capa do modelo.
  const endpoints: PublishApiEndpoint[] = []
  for (const c of doc.connectors) {
    for (const e of c.endpoints) {
      const md = renderDocFragment(doc, { kind: 'endpoint', connectorId: c.id, endpointId: e.id }) ?? ''
      endpoints.push({ key: `${c.id}/${e.id}`, method: e.method, path: sanitizer.text(e.path), name: sanitizer.text(e.name), connector: sanitizer.text(c.name), hash: sha(sanitizer.text(md)) })
    }
  }
  const cfg = project.config
  const meta: PublishMeta = { title: sanitizer.text(target.site?.title ?? cfg.title ?? doc.project.name) }
  if (cfg.subtitle) meta.subtitle = sanitizer.text(cfg.subtitle)
  if (cfg.version) meta.version = sanitizer.text(cfg.version)
  if (cfg.organization) meta.organization = sanitizer.text(cfg.organization)
  if (cfg.theme?.primary && /^#[0-9A-Fa-f]{6}$/.test(cfg.theme.primary)) meta.primary = cfg.theme.primary
  if (cfg.logo) {
    const ext = /\.([A-Za-z]+)$/.exec(cfg.logo)?.[1]?.toLowerCase() ?? ''
    const type = IMAGE_TYPES[ext]
    if (type) {
      const rel = normalizeRel(cfg.logo)
      const id = `vv-logo-${sha(rel).slice(0, 12)}.${ext}`
      await readImage(ws.dir, rel, (data) => sanitizer.leaks(Buffer.from(data).toString('latin1'))).then(
        (data) => {
          assets.set(id, { id, mediaType: type, hash: sha(data), data, file: rel })
          meta.logo = id
        },
        (err: Error) => warn(`logo "${cfg.logo}": ${err.message}`, 'vvpost.docs.json', 'warning')
      )
    }
  }
  // Um diagrama no modo "code" nunca terá imagem: não vai como anexo.
  const list = [...assets.values()].filter((a) => !(a.diagram && diagramFormat(target) === 'code'))
  return {
    bundle: {
      target: {
        id: target.id,
        name: target.name ?? target.id,
        provider: target.provider,
        destination: target.destination,
        diagrams: diagramFormat(target)
      },
      project: doc.project.name,
      generatedAt: (options.now ?? new Date()).toISOString(),
      nodes,
      assets: list,
      published: target.published ?? {},
      meta,
      api: { endpoints },
      ...(target.site && { site: target.site })
    },
    diagnostics
  }
}

/** Formato dos diagramas do destino: o do arquivo ou, sem ele, SVG no site html e PNG nos outros. */
export function diagramFormat(target: Pick<PublishTarget, 'diagrams' | 'provider'>): 'png' | 'svg' | 'code' {
  return target.diagrams ?? (target.provider === 'html' ? 'svg' : 'png')
}

/**
 * SVG do Mermaid como arquivo .svg: o HTML dos rótulos (foreignObject) vem com <br> sem fechar e
 * &nbsp;, que o navegador aceita inline mas não num <img> nem num anexo (o SVG é XML).
 */
export function svgFile(svg: string): string {
  let out = svg.replace(/<(br|hr|img|wbr)\b([^>]*?)\s*\/?>/gi, '<$1$2/>').replace(/&nbsp;/g, '&#160;')
  // width="100%" com max-width no style: como arquivo, o diagrama esticaria até a largura da página.
  const root = /^<svg\b[^>]*>/.exec(out)?.[0]
  const max = root && /\bwidth="100%"/.test(root) ? /max-width:\s*([\d.]+)px/.exec(root)?.[1] : undefined
  const box = root ? /\bviewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(root) : null
  if (root && max) {
    const width = Number(max)
    const height = box && Number(box[1]) > 0 ? Math.round((width * Number(box[2])) / Number(box[1])) : undefined
    const fixed = root.replace(/\bwidth="100%"/, `width="${width}"${height !== undefined && !/\bheight=/.test(root) ? ` height="${height}"` : ''}`)
    out = fixed + out.slice(root.length)
  }
  return out
}

/** Diagramas que ainda precisam de imagem, para quem tem o Mermaid. */
export function pendingDiagrams(bundle: PublishBundle): { id: string; source: string }[] {
  return bundle.assets.filter((a) => a.diagram !== undefined && !a.data).map((a) => ({ id: a.id, source: a.diagram! }))
}

function parseSource(source: string, doc: ApiDocument, files: string[]): Source | { error: string } {
  if (source === 'document') return { kind: 'document' }
  if (source.startsWith('connector:')) {
    const id = source.slice('connector:'.length)
    return doc.connectors.some((c) => c.id === id) ? { kind: 'connector', connectorId: id, withEndpoints: true } : { error: `conector "${id}" não existe no projeto` }
  }
  if (source.startsWith('endpoint:')) {
    const ref = source.slice('endpoint:'.length)
    const cut = ref.lastIndexOf('/')
    const connectorId = ref.slice(0, cut)
    const endpointId = ref.slice(cut + 1)
    const c = doc.connectors.find((x) => x.id === connectorId)
    if (cut <= 0 || !c?.endpoints.some((e) => e.id === endpointId)) return { error: `endpoint "${ref}" não existe no projeto` }
    return { kind: 'endpoint', connectorId, endpointId }
  }
  const [path = '', section] = source.split('#')
  const file = normalizeRel(path)
  if (!/\.md$/i.test(file)) return { error: `"${source}" não é "document", um .md, connector:<id> nem endpoint:<conector>/<endpoint>` }
  if (file.startsWith('..')) return { error: `"${source}" fica fora do workspace` }
  if (!files.includes(file)) return { error: `"${file}" não existe no workspace` }
  return { kind: 'file', file, ...(section?.trim() && { section: section.trim() }) }
}

function sourceKey(s: Source): string {
  switch (s.kind) {
    case 'document':
      return 'document'
    case 'file':
      return `file:${s.file}${s.section ? `#${s.section}` : ''}`
    case 'connector':
      return `connector:${s.connectorId}`
    case 'endpoint':
      return `endpoint:${s.connectorId}/${s.endpointId}`
  }
}

/** O documento só com o que a página mostra: o conector sem os endpoints quando eles viram páginas filhas. */
function viewFor(doc: ApiDocument, s: Extract<Source, { kind: 'connector' | 'endpoint' }>): ApiDocument {
  if (s.kind !== 'connector' || s.withEndpoints) return doc
  return { ...doc, connectors: doc.connectors.map((c) => (c.id === s.connectorId ? { ...c, endpoints: [], omittedEndpoints: 0 } : c)) }
}

function fileTitle(template: string, file: string, heading: string | undefined): string {
  const name = file.split('/').pop()!.replace(/\.md$/i, '')
  const clean = heading?.replace(/\s*\{#[^}]*\}\s*$/, '').replace(/[*_`]/g, '').trim()
  return template.replaceAll('{{heading}}', clean || name).replaceAll('{{file}}', name).trim() || name
}

/**
 * A página tem título próprio no destino: o primeiro título do Markdown sai quando repete o da
 * página (ou sempre, nos trechos gerados), e os outros sobem para começar no nível 2.
 */
function dropTitle(markdown: string, title: string | null): string {
  const sections = markdownSections(markdown)
  const first = sections[0]
  let text = markdown
  if (first && (title === null || first.title.replace(/\s*\{#[^}]*\}\s*$/, '').trim() === title.trim())) {
    const lines = markdown.split('\n')
    const at = lines.findIndex((l) => /^#{1,6}\s/.test(l))
    if (at >= 0 && lines.slice(0, at).every((l) => !l.trim())) text = lines.slice(at + 1).join('\n')
  }
  return shiftHeadings(text.trim(), 2) + '\n'
}

/** Caminho de um link ou imagem relativo ao arquivo em que ele está. */
function fromFile(file: string, path: string): string {
  return normalizeRel(`${file.split('/').slice(0, -1).join('/')}/${path}`)
}

function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

async function readImage(dir: string, rel: string, leaks: (data: Uint8Array) => boolean): Promise<Uint8Array> {
  const path = await resolveWorkspaceFile(dir, rel)
  const info = await stat(path)
  if (!info.isFile()) throw new DocsError('não é um arquivo')
  if (info.size > MAX_IMAGE_BYTES) throw new DocsError('passa de 10 MB')
  const data = new Uint8Array(await readFile(path))
  // Um SVG é texto (e um PNG pode levar texto nos metadados): com segredo, não vai.
  if (leaks(data)) throw new DocsError('tem o valor de uma credencial')
  return data
}

function withoutMissingImages(blocks: PublishBlock[], has: (id: string) => boolean): void {
  const inline = (list: PublishInline[]) => {
    list.forEach((n, i) => {
      if (n.type === 'image' && n.asset && !has(n.asset)) list[i] = { type: 'text', text: n.alt }
      else if ('children' in n) inline(n.children)
    })
  }
  for (const b of blocks) {
    if (b.type === 'heading' || b.type === 'paragraph') inline(b.children)
    else if (b.type === 'table') [...b.header, ...b.rows.flat()].forEach(inline)
    else if (b.type === 'list') b.items.forEach((item) => withoutMissingImages(item.blocks, has))
    else if (b.type === 'alert' || b.type === 'quote') withoutMissingImages(b.blocks, has)
  }
}
