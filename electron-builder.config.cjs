// Instaladores do VVPost (electron-builder). Guia em docs/packaging.md.
//
// O app não leva node_modules: undici, Fastify, Kysely, o ajv e o motor já entram no bundle do
// electron-vite (out/), então o pacote é out/, os plugins oficiais e os ícones.
//
// Assinatura: nada de certificado no repositório. O electron-builder assina quando as variáveis
// de ambiente existem (CSC_LINK/CSC_KEY_PASSWORD, WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD, ou Azure
// Trusted Signing com AZURE_*) e, sem elas, gera o instalador sem assinatura. No macOS a
// notarização liga sozinha quando APPLE_TEAM_ID e as credenciais da Apple estão definidas.
//
// Módulo Enterprise (opcional, comercial): VVPOST_ENTERPRISE_DIR aponta para um checkout já
// compilado do repositório privado vvpost-enterprise. Só então o dist/ dele vai para
// resources/enterprise e o artefato ganha o sufixo -enterprise. Sem a variável, o build é o
// Community e nada do módulo existe neste repositório nem no instalador.
const { existsSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const enterpriseDir = process.env.VVPOST_ENTERPRISE_DIR ? resolve(process.env.VVPOST_ENTERPRISE_DIR) : null
if (enterpriseDir) {
  const pkg = join(enterpriseDir, 'package.json')
  if (!existsSync(pkg) || JSON.parse(readFileSync(pkg, 'utf8')).name !== '@vvpost/enterprise') {
    throw new Error(`VVPOST_ENTERPRISE_DIR (${enterpriseDir}) não é um checkout do vvpost-enterprise.`)
  }
  if (!existsSync(join(enterpriseDir, 'dist/index.js'))) {
    throw new Error('O módulo Enterprise não está compilado: rode `npm ci && npm run build` no vvpost-enterprise.')
  }
}
const edition = enterpriseDir ? '-enterprise' : ''


/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.vvpost.app',
  productName: 'VVPost',
  copyright: 'Copyright © 2026 Victor Verdoodt',
  directories: { output: 'dist', buildResources: 'installer' },
  files: ['out/**', '!out/**/*.map', '!out/main/vendor/**', 'resources/icon.*', 'package.json'],
  extraResources: [
    // Fora do app.asar: o processo de cada plugin lê os arquivos direto do disco.
    { from: 'plugins', to: 'plugins' },
    // Licença e avisos de terceiros junto do app instalado.
    { from: '.', to: '.', filter: ['LICENSE', 'NOTICE'] },
    { from: 'installer/bin', to: 'bin', filter: process.platform === 'win32' ? ['vvpost.cmd'] : ['vvpost'] },
    ...(enterpriseDir
      ? [
          // Só o que roda no desktop: o runner e o Control Plane são servidores e ficam de fora.
          { from: join(enterpriseDir, 'dist'), to: 'enterprise/dist', filter: ['**/*.js', '!runner/**'] },
          { from: join(enterpriseDir, 'package.json'), to: 'enterprise/package.json' }
        ]
      : [])
  ],
  asar: true,
  // Só as traduções do Chromium que a interface usa (as outras somam ~8 MB).
  electronLanguages: ['pt-BR', 'en-US'],
  compression: 'maximum',
  afterPack: 'installer/after-pack.cjs',
  // Nada é publicado pelo build: a publicação de releases é um passo manual (docs/packaging.md).
  publish: null,
  artifactName: `\${productName}-\${version}${edition}-\${os}-\${arch}.\${ext}`,
  win: {
    // O .zip e o .7z são a versão portátil: extrair e abrir o VVPost.exe, sem instalar. O .7z é
    // menor; o .zip abre sem programa extra.
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
      { target: '7z', arch: ['x64'] }
    ],
    icon: 'resources/icon.ico',
    executableName: 'VVPost',
    // Com WIN_CSC_LINK/CSC_LINK definido o build assina; sem, sai sem assinatura e avisa.
    signtoolOptions: {
      publisherName: process.env.VVPOST_WIN_PUBLISHER ? [process.env.VVPOST_WIN_PUBLISHER] : undefined,
      signingHashAlgorithms: ['sha256'],
      rfc3161TimeStampServer: 'http://timestamp.digicert.com'
    },
    ...(process.env.AZURE_TRUSTED_SIGNING_ENDPOINT && {
      azureSignOptions: {
        endpoint: process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
        codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT,
        certificateProfileName: process.env.AZURE_CERTIFICATE_PROFILE,
        publisherName: process.env.VVPOST_WIN_PUBLISHER
      }
    })
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    shortcutName: 'VVPost',
    // O pacote diferencial (padrão) comprime cada arquivo à parte para o electron-updater baixar só
    // os blocos que mudaram; o app não tem auto-update, e o 7z sólido deixa o .exe na meta.
    differentialPackage: false
  },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
    icon: 'resources/icon.png',
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'installer/mac/entitlements.mac.plist',
    entitlementsInherit: 'installer/mac/entitlements.mac.plist',
    // Sem "Developer ID Application" (CSC_LINK) o build sai sem assinatura; a notarização
    // precisa de APPLE_TEAM_ID mais APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER ou
    // APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD.
    notarize: !!process.env.APPLE_TEAM_ID
  },
  dmg: { sign: false },
  linux: {
    // AppImage fica de fora do padrão: o squashfs dele não passa de ~100 MB (meta < 85 MB). Quem
    // quiser gera com `npm run dist -- --linux AppImage`.
    target: [{ target: 'deb', arch: ['x64'] }, { target: 'tar.xz', arch: ['x64'] }],
    icon: 'resources/icon.png',
    category: 'Development',
    // vvpost (sem sufixo) é o CLI; o app é vvpost-desktop.
    executableName: 'vvpost-desktop',
    maintainer: 'Victor Verdoodt <victorverdoodt@gmail.com>',
    synopsis: 'Workspace de documentação viva para backend',
    desktop: { entry: { Name: 'VVPost', StartupWMClass: 'VVPost' } }
  },
  deb: {
    compression: 'xz',
    // O fpm comprime com XZ_OPT="-<nível>" e o padrão é -3 (~100 MB); com -9 o .deb fica na meta.
    // /usr/bin/vvpost chama o CLI que vem com o app (o .deb também cria /usr/bin/vvpost-desktop).
    fpm: ['--deb-compression-level', '9', 'installer/linux/vvpost=/usr/bin/vvpost']
  }
}
