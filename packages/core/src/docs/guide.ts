import { DOC_DIRECTIVES, DOCS_CONFIG_FILE, DEFAULT_DOCS_SOURCE } from './compose'
import { BUILTIN_DOC_TEMPLATES } from './templates'

/** Ícones do pacote vv do editor de diagramas (os mesmos de src/renderer/.../vv-icons.json). */
const VV_ICONS = ['servidor', 'banco', 'api', 'nuvem', 'internet', 'usuario', 'usuarios', 'celular', 'navegador', 'desktop', 'fila', 'evento', 'mensagem', 'email', 'cadeado', 'chave', 'escudo', 'container', 'pacote', 'servico', 'servicos', 'rede', 'disco', 'cpu', 'cache', 'arquivo', 'pasta', 'configuracao', 'relogio', 'agendador', 'busca', 'robo', 'plugin', 'terminal', 'codigo', 'git', 'fluxo', 'monitor', 'alerta', 'pagamento', 'carrinho', 'loja', 'empresa', 'log', 'grafico', 'sincronizar', 'balanceador', 'gateway', 'funcao', 'dados']

/**
 * Como uma IA documenta um projeto com o VVPost: o guia do resource do MCP, a base dos prompts
 * e o trecho para CLAUDE.md / AGENTS.md que o `vvpost docs agents` escreve.
 */
export function docsAgentGuide(): string {
  return `# Documentação do projeto com o VVPost

Este projeto documenta as APIs e o sistema com o VVPost. A documentação é **um documento só**,
montado do projeto e no padrão visual do modelo (logo, capa, cabeçalho, rodapé, cores), que o app
mostra, exporta em PDF e em .md, e que o CLI (\`vvpost docs\`) e o MCP (\`generate_docs\`) geram.
Não crie arquivos .md soltos para documentar: escreva no documento do projeto.

## Onde fica

- \`${DOCS_CONFIG_FILE}\`: o modelo (título, subtítulo, organização, versão, logo, capa, sumário,
  numeração, cores, fontes, página, cabeçalho e rodapé com {{title}}, {{page}}, {{pages}}...).
- \`${DEFAULT_DOCS_SOURCE}\` (ou o \`source\` do modelo): o documento-fonte em Markdown.
- \`docs/**.md\`: páginas (visão geral, arquitetura, guias, decisões) que o documento-fonte inclui.
- \`<conector>.connector.vvpost.md\` (ou \`<base>.flow.vvpost.md\`, num fluxo-base): a documentação escrita de cada conector (seções {#endpointId}).

## Diretivas

Uma linha sozinha \`{{> tipo argumento}}\` vira um trecho montado do projeto, sempre atualizado:

${DOC_DIRECTIVES.map((d) => `- \`${d.usage}\`: ${d.description}.`).join('\n')}

Os títulos do trecho entram um nível abaixo do título em que a diretiva está.

## Diagramas

Diagramas Mermaid entram como bloco \`\`\`mermaid no Markdown ou num arquivo .mmd em \`docs/diagramas/\`,
incluído com \`{{> diagram docs/diagramas/nome.mmd}}\`. No app, cada diagrama da documentação tem o
botão **Editar**, que abre o editor de diagramas (paleta de blocos e ícones, prévia ao vivo) e grava
de volta no mesmo lugar. Ícones: \`vv:<nome>\` (${VV_ICONS.join(', ')}) em \`architecture-beta\`
(\`service api(vv:servidor)[API]\`) e em nós do flowchart (\`api@{ icon: "vv:servidor", label: "API" }\`);
plugins podem trazer outros prefixos.

Diagramas C4 escritos à mão (\`C4Context\`, \`C4Container\`...) são comparados com o catálogo pelo lint:
cada elemento é ligado a um conector ou fluxo pelo nome ou por \`%% vvpost:bind <alias> connector:<id>\`
(ou \`flow:<id>\`), e o lint acusa conector do projeto que nenhum C4 mostra (\`c4-connector-missing\`),
elemento ligado a algo que não existe mais (\`c4-binding-unknown\`) e relação que diverge dos fluxos
(\`c4-relation-missing\`, \`c4-relation-stale\`). \`%% vvpost:cover connectors flows\` exige tudo num
diagrama e \`%% vvpost:ignore connector:<id>\` deixa um de fora de propósito. Citações em código
inline (\`conector/endpoint\`) que não existem mais viram \`doc-unknown-reference\`, e num repositório Git a
página de arquitetura revisada antes da última mudança estrutural do que ela mostra vira
\`doc-stale-since-change\`. Fluxogramas e \`architecture-beta\` entram com alguma anotação \`%% vvpost:\`.
\`fix_diagrams\` corrige o que é estrutural (elemento que falta ou sobrou, relações dos fluxos).
\`{{> c4}}\` gera um C4 de contexto do catálogo, que nunca fica velho.

## Modelos de metodologia

${BUILTIN_DOC_TEMPLATES.map((t) => `- \`${t.id}\` ${t.name}: ${t.description}`).join('\n')}

O projeto e o usuário podem ter modelos próprios (\`*.doc-template.vvpost.json\`).

## Como trabalhar (MCP)

1. \`get_docs_project\`: o modelo, a fonte, as páginas, os modelos disponíveis e os diagnósticos.
2. Sem documento ainda, comece de um modelo: \`save_docs_project\` com \`template\` (ex.: \`builtin:c4\`).
3. Escreva as páginas de nível de projeto com \`write_docs_page\` (\`docs/visao-geral.md\`,
   \`docs/arquitetura.md\`...) e junte no documento com \`{{> include docs/pagina.md}}\`.
4. Use as diretivas para o que vem do projeto (endpoints, conectores, mapa, fluxos, ambientes),
   em vez de copiar caminhos, headers ou exemplos à mão.
5. Grave a fonte e o modelo com \`save_docs_project\` (\`dryRun: true\` antes) e corrija os
   diagnósticos por linha.
6. Confira a estrutura com \`generate_docs { outline: true }\` (sem outline, vem o Markdown inteiro).
7. Um padrão que o time vai repetir vira modelo com \`save_docs_template\`.

Credenciais nunca entram na documentação: variáveis secretas aparecem só pelo nome, e o VVPost
recusa gravar texto com o valor de um segredo do workspace.

## Pelo terminal

- \`vvpost docs init --template c4\`: cria o modelo e o documento de partida.
- \`vvpost docs templates\`: lista os modelos.
- \`vvpost docs --strict --out docs.md\`: gera o documento e falha se alguma diretiva tiver erro.
`
}

/** Marca do trecho no CLAUDE.md / AGENTS.md, para não repetir ao rodar de novo. */
export const AGENT_SNIPPET_MARK = '<!-- vvpost:docs -->'

/** Onde este repositório é documentado no VVPost, para a IA achar o projeto sem perguntar. */
export interface AgentSnippetContext {
  workspace: string
  project?: string
}

/** Trecho curto para CLAUDE.md / AGENTS.md: diz à IA que a documentação do projeto é a do VVPost. */
export function docsAgentSnippet(context?: AgentSnippetContext): string {
  const where = context
    ? `\nEste repositório é documentado no workspace VVPost \`${context.workspace}\`${context.project ? `, projeto \`${context.project}\` (passe \`project: "${context.project}"\` nas ferramentas do MCP)` : ''}.\n`
    : ''
  return `${AGENT_SNIPPET_MARK}
## Documentação (VVPost)
${where}
A documentação deste projeto é escrita no VVPost, não em arquivos .md soltos:

- **Código e documentação andam juntos.** Ao mudar o código (APIs, integrações, regras, arquitetura),
  atualize no mesmo trabalho, sem esperar pedido, o projeto no VVPost: o catálogo (\`edit_project\`), as
  páginas que descrevem o que mudou (\`write_docs_page\` com \`edits\`) e o PDF (\`export_docs\`), quando
  a resposta de escrita trouxer \`stalePdf\` (sem ele, não exporte). As respostas de escrita dizem o que ficou para trás (\`documentErrors\`).
- Pelo MCP do VVPost: \`get_docs_project\` para ler, \`save_docs_project\` (com \`template\`, ex.: \`builtin:c4\`) para o
  documento e o modelo, \`write_docs_page\` para páginas em \`docs/\` incluídas com \`{{> include docs/pagina.md}}\`,
  e \`generate_docs\` com \`outline: true\` para ver a estrutura.
- Uma mudança de API é um \`edit_project\` só, tudo ou nada: \`replaceReferences\` para o nome que mudou
  (catálogo, schemas e páginas), \`setSchemaField\` com \`fillExamples: true\` para um campo novo e
  \`writePage\` com \`edits\` para o texto das páginas. Não precisa de \`dryRun\`: com erro, nada é gravado.
- Se o catálogo segue uma spec OpenAPI gerada pelo código (conector com \`source\`), depois de mudar a API e
  regerar a spec rode \`sync_openapi\` com \`apply: true\` em vez de editar os endpoints à mão, e trate os \`breaks\`.
- Para chamar uma API do catálogo, use \`execute_dry_run\` com \`request\` (e \`select\` para trazer só os
  campos que interessam), em vez de \`curl\` ou script.
- Use as diretivas \`{{> endpoint <conector>/<endpoint>}}\`, \`{{> connector <id>}}\`, \`{{> map}}\`, \`{{> flows}}\` e
  \`{{> reference}}\` em vez de copiar detalhes das APIs à mão.
- O mapa do código (uma linha por área com os arquivos) entra na documentação com \`{{> codemap <pasta>}}\`; a cópia no
  AGENTS.md leva \`<!-- vvpost:codemap <pasta> -->\` logo acima das linhas, e o achado \`doc-code-map\` traz a linha certa.
- As respostas de escrita já conferem o documento (\`documentErrors\`); \`vvpost docs --strict\` é para o CI, não precisa rodar.
- Se a escrita devolver em \`lint\` achados \`c4-*\` ou \`doc-unknown-reference\`, o C4 ou um ADR ficou velho: atualize o diagrama
  (\`fix_diagrams\` com \`apply: true\`, ou o Mermaid pronto do \`hint\`) ou o texto na mesma mudança.
- Antes de mexer no frontend (tela, CSS, tema), leia a marca com \`get_brand\` e use os tokens em vez de escrever
  cores e fontes à mão; achados \`brand-*\` ou \`tokens-*\` no \`lint\` da escrita se corrigem na mesma mudança.
- Nunca escreva valores de credenciais; variáveis secretas aparecem só pelo nome.
`
}

/** Arquivos de instruções do repositório que recebem o trecho. */
export const AGENT_RULE_FILES = ['CLAUDE.md', 'AGENTS.md'] as const

/** O CLAUDE.md que só importa o AGENTS.md: o Claude Code lê os dois com um arquivo de regras só. */
export const CLAUDE_IMPORTS_AGENTS = '@AGENTS.md\n'

/**
 * Onde a regra entra quando ninguém escolheu o arquivo. O Codex, o Cursor, o Copilot e o OpenCode leem o AGENTS.md, e o
 * Codex não lê o CLAUDE.md; o Claude Code lê o CLAUDE.md, que importa o AGENTS.md com `@AGENTS.md`.
 * - Com o trecho já num dos dois: nele.
 * - Com AGENTS.md (ou sem nenhum): no AGENTS.md, e o CLAUDE.md passa a importá-lo (`claudeImport`), criado se falta.
 * - Só com CLAUDE.md: no CLAUDE.md, como antes, com o aviso de que o Codex não vai ler (`note`).
 */
export async function agentRuleTarget(repo: string): Promise<{ file: 'CLAUDE.md' | 'AGENTS.md'; claudeImport?: true; note?: string }> {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const done = await agentSnippetFile(repo)
  if (done) return { file: done }
  const hasClaude = existsSync(join(repo, 'CLAUDE.md'))
  if (existsSync(join(repo, 'AGENTS.md')) || !hasClaude) {
    return (await importsAgents(join(repo, 'CLAUDE.md'))) ? { file: 'AGENTS.md' } : { file: 'AGENTS.md', claudeImport: true }
  }
  return {
    file: 'CLAUDE.md',
    note: 'o Codex lê só o AGENTS.md: para ele ver a regra, passe o conteúdo do CLAUDE.md para um AGENTS.md e deixe no CLAUDE.md a linha @AGENTS.md'
  }
}

async function importsAgents(claude: string): Promise<boolean> {
  const { readFile } = await import('node:fs/promises')
  return /^@AGENTS\.md\s*$/m.test(await readFile(claude, 'utf8').catch(() => ''))
}

/** Garante a linha `@AGENTS.md` no CLAUDE.md (cria o arquivo se falta), para o Claude Code ler a regra do AGENTS.md. */
export async function ensureClaudeImportsAgents(repo: string, options: { dryRun?: boolean } = {}): Promise<'created' | 'appended' | 'unchanged'> {
  const { existsSync } = await import('node:fs')
  const { readFile, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const claude = join(repo, 'CLAUDE.md')
  if (await importsAgents(claude)) return 'unchanged'
  const current = existsSync(claude) ? await readFile(claude, 'utf8') : ''
  const action = current ? 'appended' : 'created'
  if (!options.dryRun) await writeFile(claude, current ? `${current}${current.endsWith('\n') ? '' : '\n'}\n${CLAUDE_IMPORTS_AGENTS}` : CLAUDE_IMPORTS_AGENTS)
  return action
}

/** A raiz do repositório git que contém a pasta (ou a própria pasta, fora de um repositório). */
export async function codeRepoRoot(dir: string): Promise<string> {
  const { existsSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at
    if (dirname(at) === at) return dir
  }
}

/** Qual arquivo de instruções do repositório já tem o trecho do VVPost, se algum. */
export async function agentSnippetFile(repo: string): Promise<(typeof AGENT_RULE_FILES)[number] | null> {
  const { existsSync } = await import('node:fs')
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  for (const name of AGENT_RULE_FILES) {
    const file = join(repo, name)
    if (existsSync(file) && (await readFile(file, 'utf8').catch(() => '')).includes(AGENT_SNIPPET_MARK)) return name
  }
  return null
}

/**
 * Acrescenta o trecho ao arquivo de instruções do repositório (o `vvpost docs agents --out` e o
 * install_agent_rules do MCP). Idempotente: com o trecho já lá, não muda nada.
 */
export async function installAgentSnippet(
  target: string,
  context?: AgentSnippetContext,
  options: { dryRun?: boolean } = {}
): Promise<{ file: string; action: 'created' | 'appended' | 'unchanged' }> {
  const { existsSync } = await import('node:fs')
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  const current = existsSync(target) ? await readFile(target, 'utf8') : ''
  if (current.includes(AGENT_SNIPPET_MARK)) return { file: target, action: 'unchanged' }
  const action = current ? 'appended' : 'created'
  if (options.dryRun) return { file: target, action }
  await mkdir(dirname(target), { recursive: true })
  const sep = !current ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  await writeFile(target, current + sep + docsAgentSnippet(context))
  return { file: target, action }
}
