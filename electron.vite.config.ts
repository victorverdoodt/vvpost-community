import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')

/**
 * O mermaid.min.js em out/main/vendor: o CLI e o MCP sem o executável do VVPost mandam junto do
 * site exportado para o navegador desenhar os diagramas (src/main/docs/mermaid-script.ts). O
 * instalador não leva (electron-builder.config.cjs): no app, os diagramas viram imagem.
 */
function vendorMermaid(): Plugin {
  return {
    name: 'vvpost-vendor-mermaid',
    apply: 'build',
    closeBundle() {
      const dir = resolve(__dirname, 'out/main/vendor')
      mkdirSync(dir, { recursive: true })
      copyFileSync(resolve(__dirname, 'node_modules/mermaid/dist/mermaid.min.js'), resolve(dir, 'mermaid.min.js'))
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    plugins: [vendorMermaid()],
    // undici, Kysely, Fastify e @vvpost/schemas (com o ajv) entram no bundle, em chunks carregados
    // sob demanda, em vez de irem como node_modules no instalador. O Kysely é ESM-only
    // e o @vvpost/schemas e o @vvpost/core (o motor) exportam TypeScript direto.
    // mcp.js é o servidor MCP fora do app (stdio/HTTP), rodando em Node puro: divide os
    // chunks de conectores e dispatcher com o app, mas não entra no cold start dele.
    // cli.js é o `vvpost` para CI/CD, também em Node puro, sobre o mesmo motor (src/main/core).
    build: {
      externalizeDeps: { exclude: ['undici', 'kysely', '@vvpost/schemas', '@vvpost/core', 'fastify'] },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          mcp: resolve(__dirname, 'src/main/mcp/cli.ts'),
          cli: resolve(__dirname, 'src/main/cli/bin.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    // O preload roda em sandbox, sem require de pacotes: o @shared/ipc reexporta tipos e
    // constantes do @vvpost/core, que precisam entrar no bundle.
    build: { externalizeDeps: { exclude: ['@vvpost/core'] } }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    // print.html é a página do PDF impresso fora da janela do app (src/main/docs/print-worker.ts).
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          print: resolve(__dirname, 'src/renderer/print.html')
        }
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
