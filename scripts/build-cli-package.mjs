#!/usr/bin/env node
// Monta o pacote npm `vvpost` (packages/cli): o CLI e o servidor MCP num bundle CommonJS para
// Node puro, sem dependências em runtime (undici, Fastify, Kysely, o ajv e o motor entram no
// bundle), mais os plugins oficiais e a licença. O pacote fica pronto para `npm pack` ou
// `npm publish` dentro de packages/cli; nada é publicado por aqui.
// Uso: npm run build:cli
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(root, 'packages/cli')
const outDir = join(pkgDir, 'dist/main')

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const cliPkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
if (cliPkg.version !== rootPkg.version) {
  throw new Error(`packages/cli está na versão ${cliPkg.version} e o app na ${rootPkg.version}: as duas andam juntas.`)
}

rmSync(join(pkgDir, 'dist'), { recursive: true, force: true })
rmSync(join(pkgDir, 'plugins'), { recursive: true, force: true })

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  resolve: { alias: { '@shared': join(root, 'src/shared') } },
  // O motor e os schemas exportam TypeScript direto: tudo entra no bundle.
  ssr: { noExternal: true, target: 'node' },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    ssr: true,
    target: 'node22',
    outDir,
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: { cli: join(root, 'src/main/cli/bin.ts'), mcp: join(root, 'src/main/mcp/cli.ts') },
      // electron fica de fora para o build falhar alto (no teste abaixo) se o CLI passar a importá-lo.
      external: [...builtinModules, /^node:/, 'electron'],
      output: { format: 'cjs', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' }
    }
  }
})

// dist/main/cli.js → raiz do pacote, onde o CLI procura a pasta plugins/ dos oficiais (como no app).
cpSync(join(root, 'plugins'), join(pkgDir, 'plugins'), { recursive: true })
copyFileSync(join(root, 'LICENSE'), join(pkgDir, 'LICENSE'))
// O Mermaid do site exportado sem o executável do VVPost (src/main/docs/mermaid-script.ts).
mkdirSync(join(outDir, 'vendor'), { recursive: true })
copyFileSync(join(root, 'node_modules/mermaid/dist/mermaid.min.js'), join(outDir, 'vendor/mermaid.min.js'))

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else files.push(path)
  }
}
walk(join(pkgDir, 'dist'))
for (const file of files) {
  if (/require\(["']electron["']\)/.test(readFileSync(file, 'utf8'))) {
    throw new Error(`${relative(root, file)} importa o Electron: o pacote npm roda em Node puro.`)
  }
}
for (const entry of ['cli.js', 'mcp.js']) {
  if (!existsSync(join(outDir, entry))) throw new Error(`faltou ${entry} no bundle`)
}
const bytes = files.reduce((sum, f) => sum + statSync(f).size, 0)
console.log(`packages/cli pronto: ${files.length} arquivos, ${(bytes / 1024 / 1024).toFixed(1)} MB sem compressão.`)
