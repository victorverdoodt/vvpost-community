import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(dirname(fileURLToPath(import.meta.url)), 'src/shared') } },
  // Os testes que montam workspace, Git e o CLI passam de 5 s com a suíte inteira em paralelo no Windows.
  test: { include: ['test/**/*.test.ts'], environment: 'node', setupFiles: ['test/setup-vault.ts'], testTimeout: 30_000 }
})
