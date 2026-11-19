// Lint de regras no estilo do Spectral (docs/lint.md): regras com JSONPath sobre o workspace e
// sobre a spec OpenAPI exportada. Chunk carregado sob demanda pelo app, pelo CLI e pelo MCP.
export { BUILTIN_RULESETS } from './builtin'
export { buildLintDocument, type LintBrandToken, type LintDocPage, type LintWorkspaceDocument } from './document'
export { failsAt, runLint, summarize, type LintDocument, type LintFinding, type LintLocation, type LintSummary, type LintTarget } from './engine'
export { LINT_FUNCTIONS, type LintFunction } from './functions'
export { formatJsonPath, JsonPathError, queryJsonPath, type JsonPathMatch, type JsonPathSegment } from './jsonpath'
export {
  DEFAULT_RULESET,
  globToRegExp,
  normalizeSeverity,
  resolveRuleset,
  RulesetError,
  SEVERITIES,
  severityFor,
  type LintFormat,
  type LintRule,
  type LintSeverity,
  type ResolvedRuleset,
  type RuleSeverity,
  type RulesetLoader
} from './ruleset'
