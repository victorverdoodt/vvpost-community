// Documentação rica por nível da hierarquia (projeto, conector, endpoint, request). Chunk
// carregado sob demanda pelo app, pelo CLI e pelo MCP: nada daqui pesa no cold start.
export { DocsError, ENDPOINT_ORIGIN, generateDocumentation, type GenerateDocsOptions, type GeneratedDocs } from './build'
export { renderDocFragment, renderDocMarkdown, slugBase, type DocFragment } from './markdown'
export {
  composeDocumentation,
  DEFAULT_DOCS_SOURCE,
  DOC_DIRECTIVES,
  DOCS_STARTER_SOURCE,
  DOCS_CONFIG_FILE,
  extractSection,
  listDocsFiles,
  loadDocsProject,
  markdownSections,
  normalizeRel,
  parseDocsConfig,
  readDocsLogo,
  resolveWorkspaceFile,
  shiftHeadings,
  workspaceWritePath,
  writeDocsPage,
  writeDocsProject,
  type ComposedDocs,
  type ComposeOptions,
  type DocDiagnostic,
  type DocsMarkdownFile,
  type DocsProject
} from './compose'
export type * from './model'
export { escapeHtml, fillPlaceholders, printLayout, type PrintContext, type PrintLayout } from './theme'
export {
  applyDocTemplate,
  BUILTIN_DOC_TEMPLATES,
  DOC_TEMPLATE_SUFFIX,
  docTemplateFileName,
  listDocTemplates,
  parseDocTemplate,
  saveDocTemplate,
  type DocTemplate,
  type DocTemplateOrigin
} from './templates'
export { AGENT_RULE_FILES, AGENT_SNIPPET_MARK, CLAUDE_IMPORTS_AGENTS, agentRuleTarget, agentSnippetFile, ensureClaudeImportsAgents, codeRepoRoot, docsAgentGuide, docsAgentSnippet, installAgentSnippet, type AgentSnippetContext } from './guide'
export {
  DIAGRAM_ORIGIN,
  DIAGRAMS_DIR,
  diagramFileName,
  readDiagram,
  splitDiagramOrigin,
  writeDiagram,
  type DiagramOrigin,
  type WriteDiagramInput
} from './diagram-files'
export { markdownFileName, readMarkdownFile, writeMarkdownFile, type WriteMarkdownInput } from './markdown-files'
export { deleteDocsFile, renameDocsFile } from './doc-files'
