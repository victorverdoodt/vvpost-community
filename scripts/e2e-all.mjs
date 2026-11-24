// Roda os E2E em sequência, como o npm run test:e2e. Todos usam um cofre local (@vvpost/core/vault)
// numa pasta temporária, com a chave em arquivo: o app, o CLI e o MCP que cada script abre leem o
// mesmo cofre, e nada toca o cofre nem o keychain de quem roda os testes.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = [
  'e2e-quick-request.mjs',
  'e2e-http-client.mjs',
  'e2e-auth-browser.mjs',
  'e2e-postman-import.mjs',
  'e2e-openapi-import.mjs',
  'e2e-foreign-import.mjs',
  'e2e-bundle.mjs',
  'e2e-archive.mjs',
  'e2e-git-workspace.mjs',
  'e2e-headless-auth.mjs',
  'e2e-prepare-flow.mjs',
  'e2e-request-scripts.mjs',
  'e2e-scenarios.mjs',
  'e2e-pii-people.mjs',
  'e2e-editors.mjs',
  'e2e-secret-engine.mjs',
  'e2e-catalog.mjs',
  'e2e-docs.mjs',
  'e2e-docs-editor.mjs',
  'e2e-docs-publish.mjs',
  'e2e-docs-publish-plugin.mjs',
  'e2e-docs-export.mjs',
  'e2e-diagram-editor.mjs',
  'e2e-flows.mjs',
  'e2e-mcp.mjs',
  'e2e-mcp-export.mjs',
  'e2e-plugins.mjs',
  'e2e-cli.mjs',
  'e2e-secrets-module.mjs',
  'e2e-shell-modules.mjs',
  'e2e-remote-run.mjs',
  'e2e-accessibility.mjs',
  'e2e-identity.mjs',
  'e2e-ux-study.mjs',
  'e2e-onboarding.mjs',
  'e2e-new-project.mjs',
  'e2e-panel-resize.mjs',
  'e2e-panel-dock.mjs',
  'e2e-panel-tabs.mjs',
  'e2e-enterprise-identity.mjs',
  'e2e-response-views.mjs',
  'e2e-context-menus.mjs',
  'e2e-webhooks.mjs',
  'e2e-mock.mjs',
  'e2e-graphql.mjs',
  'e2e-realtime.mjs',
  'e2e-schema-form.mjs',
  'e2e-schema-builder.mjs',
  'e2e-workspace-tabs.mjs',
  'e2e-brand-tab.mjs',
  'e2e-disk-changes.mjs',
  'e2e-write-problems.mjs',
  'e2e-request-flow.mjs',
  'e2e-flow-inheritance.mjs',
  'e2e-projects.mjs',
  'e2e-architecture-drift.mjs'
]

const here = dirname(fileURLToPath(import.meta.url))
const vault = mkdtempSync(join(tmpdir(), 'vvpost-e2e-vault-'))
const env = { ...process.env, VVPOST_VAULT_DIR: vault, VVPOST_VAULT_KEYSTORE: 'file' }
let code = 0
for (const script of SCRIPTS) {
  const r = spawnSync(process.execPath, [join(here, script)], { stdio: 'inherit', env })
  if (r.status !== 0) {
    console.error(`E2E falhou: ${script} (código ${r.status ?? r.signal})`)
    code = r.status || 1
    break
  }
}
rmSync(vault, { recursive: true, force: true })
process.exit(code)
