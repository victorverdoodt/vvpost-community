# Empacotamento e distribuição

Como gerar os instaladores do app, o pacote npm do CLI (`npx vvpost`) e o build com o módulo
Enterprise, e o que falta para publicar cada um. Nada aqui publica nada sozinho: lojas, npm e
GitHub Releases são passos manuais do mantenedor.

## Instaladores do app

O app é empacotado com [electron-builder](https://www.electron.build), configurado em
[`electron-builder.config.cjs`](../electron-builder.config.cjs). O instalador não leva
`node_modules`: undici, Fastify, Kysely, o ajv e o motor já entram no bundle do electron-vite, então
o pacote é `out/` (sem source maps), os ícones e, fora do `app.asar`, os plugins oficiais
(`resources/plugins`) e o comando `vvpost` (`resources/bin`).

```sh
npm ci
npm run dist                 # instaladores do sistema atual em dist/
npm run dist -- --linux      # só Linux (.deb e .tar.xz)
npm run dist:dir             # só a pasta desempacotada (dist/linux-unpacked, dist/win-unpacked...)
npm run check:installer      # confere o tamanho de cada instalador contra perf-budgets.json
```

| Sistema | Artefatos | Observação |
| --- | --- | --- |
| Windows | `VVPost-<versão>-win-x64.exe` (NSIS, por usuário, com escolha de pasta) e a versão portátil em `-win-x64.zip` e `-win-x64.7z` (extrair e abrir o `VVPost.exe`; o `.7z` é menor e pede o 7-Zip) | Comprimido com LZMA (7-Zip). O `.zip` e o `.7z` ficam fora da meta de tamanho |
| macOS | `VVPost-<versão>-mac-arm64.dmg` e `-x64.dmg`, mais os `.zip` | Hardened Runtime e notarização prontos. Só gera num Mac |
| Linux | `VVPost-<versão>-linux-amd64.deb` e `-x64.tar.xz` | xz nível 9. AppImage é opcional: `npm run dist -- --linux AppImage` (~100 MB, fora da meta) |

### Tamanho (meta < 85 MB)

`installerMB` em `perf-budgets.json` (MiB, como o Explorer e o `du -h` mostram) com `enforce: true`:
`npm run check:installer` falha se um `.dmg`, `.deb` ou `.tar.xz` passar de 85 MB, ou se o `.exe`
passar de 95 MB (`exeMax`, a meta própria do Windows, explicada abaixo). O que
pesa é o próprio Electron: o executável tem ~220 MB e, comprimido, ~65 MB; o app (`app.asar`)
fica em ~3 MB comprimido. Para caber na meta:

- só as traduções do Chromium que a interface usa (`pt-BR` e `en-US`, ~8 MB a menos);
- sem o SwiftShader (Vulkan e WebGL por software), que o app não usa porque roda com composição
  por software; o `installer/after-pack.cjs` tira os arquivos no Linux e no Windows (no macOS eles
  ficam dentro do Electron Framework, que é assinado como um todo);
- `.deb` com xz nível 9 (o padrão do fpm é 3, que deixava o pacote com ~100 MB);
- no Windows, sem o `dxcompiler.dll` e o `dxil.dll` (compilador de shaders do DirectX 12, só do
  WebGPU), ~7 MB a menos no instalador;
- NSIS com `differentialPackage: false`: o 7z sai sólido em vez de um arquivo por vez (o pacote
  diferencial só serve ao electron-updater, que o app não usa), ~9 MB a menos.

No Linux (Electron 44.9.3), o `.deb` tem 83,6 MB e o `.tar.xz`, 82,9 MB. O app
empacotado abre em ~301 ms, com ~207 MB de RAM (PSS) em repouso, igual ao build de `out/`
(`npm run bench -- --app dist/linux-unpacked/vvpost-desktop`).

No Windows 10 (Electron 44.9.3, sem assinatura), o `.exe` tem **93,2 MB**. Instalado em silêncio
(`/S /D=<pasta>`) em ~23 s, o app abre em ~660 ms com ~138 MB de RAM (private bytes) e o
`vvpost.cmd` responde. O piso é o próprio Electron: o `VVPost.exe` (235 MB) comprime para ~69 MB
com o filtro BCJ, o único que o extrator do NSIS lê (com BCJ2 seriam ~61 MB, mas o NSIS não
descompacta), e o `resources.pak` (12 MB) já vem comprimido. Chegar a 85 MB no Windows pediria outro
formato de instalador, por isso o `.exe` tem a meta própria de 95 MB. O build pede Node 22.19+. O
tamanho no macOS depende de um build num Mac (ou do workflow de release); o Electron do macOS é
maior, então o `.dmg` tende a passar da meta.

### Assinatura

Nenhum certificado mora no repositório. O electron-builder assina quando encontra as variáveis de
ambiente abaixo e, sem elas, gera o instalador sem assinatura (com um aviso).

| Sistema | O que é preciso | Variáveis |
| --- | --- | --- |
| Windows (certificado `.pfx`) | Certificado de assinatura de código (OV ou EV) | `WIN_CSC_LINK` (caminho ou base64 do `.pfx`), `WIN_CSC_KEY_PASSWORD`, `VVPOST_WIN_PUBLISHER` (nome exato do certificado) |
| Windows (Azure Trusted Signing) | Conta do Trusted Signing e um perfil de certificado | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_ACCOUNT`, `AZURE_CERTIFICATE_PROFILE`, `VVPOST_WIN_PUBLISHER` |
| macOS | Apple Developer Program, certificado "Developer ID Application" e uma chave da App Store Connect para notarizar | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_API_KEY` (arquivo `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` |
| Linux | Nada: `.deb` e `.tar.xz` não são assinados pelo electron-builder | |

A notarização do macOS liga sozinha quando `APPLE_TEAM_ID` existe. As entitlements do Hardened
Runtime ficam em `installer/mac/entitlements.mac.plist` (só JIT do V8). O fuse `RunAsNode` do
Electron precisa continuar ligado: o comando `vvpost` do instalador e os plugins rodam com
`ELECTRON_RUN_AS_NODE`.

### O comando `vvpost` no instalador

O CLI vem junto do app e roda no Electron dele em modo Node, sem precisar de Node instalado.

| Sistema | Onde fica |
| --- | --- |
| Linux (`.deb`) | `/usr/bin/vvpost` (o app é `vvpost-desktop`) |
| Linux (`.tar.xz`) | `<pasta>/resources/bin/vvpost` |
| Windows | `%LOCALAPPDATA%\Programs\VVPost\resources\bin\vvpost.cmd` (pasta padrão); adicione `resources\bin` ao `PATH` |
| macOS | `/Applications/VVPost.app/Contents/Resources/bin/vvpost`; para usar no terminal: `ln -s /Applications/VVPost.app/Contents/Resources/bin/vvpost /usr/local/bin/vvpost` |

O app empacotado usa a mesma pasta de dados do desenvolvimento e do CLI (`~/.config/vvpost`,
`%APPDATA%\vvpost`, `~/Library/Application Support/vvpost`), então os plugins instalados no
Extensions Hub valem para os dois.

## Pacote npm do CLI (`npx vvpost`)

O pacote `vvpost` mora em [`packages/cli`](../packages/cli). `npm run build:cli` gera um bundle
CommonJS para Node 22.19+ com o CLI (`vvpost`) e o servidor MCP (`vvpost-mcp`), sem nenhuma
dependência em runtime, e copia os plugins oficiais e a licença. O build falha se algum arquivo
do bundle importar o Electron ou se a versão do pacote for diferente da do app.

```sh
npm run build && npm run build:cli
node scripts/e2e-cli.mjs --npm             # empacota com npm pack, instala o .tgz e roda o E2E nele
cd packages/cli && npm pack --dry-run      # o que vai para o registro (~0,6 MB comprimido)
```

Confira se o nome `vvpost` continua livre no npm antes da primeira publicação. Para publicar: `npm login` (ou o segredo
`NPM_TOKEN`) e `npm publish` dentro de `packages/cli`, ou o workflow de release com
`publish_npm` marcado. O `publishConfig` já pede `access: public` e `provenance` (o provenance só
funciona publicando pelo GitHub Actions).

## Build com o módulo Enterprise

O módulo Enterprise é comercial e fica no repositório privado `vvpost-enterprise`. Este
repositório não tem nada dele: só o ponto de extensão que o carrega. Para gerar um instalador
com o módulo:

```sh
# no vvpost-enterprise
npm ci && npm run build
# no vvpost-community
VVPOST_ENTERPRISE_DIR=../vvpost-enterprise npm run dist
```

Com a variável, o `dist/` compilado do módulo (sem o runner, que é servidor) e o `package.json`
dele vão para `resources/enterprise`, e os artefatos ganham o sufixo `-enterprise`. O app
empacotado procura `resources/enterprise/dist/index.js` e, se existir, usa como módulo
(`setBundledEnterpriseModule`); `VVPOST_ENTERPRISE_MODULE` continua tendo prioridade. Sem a
variável, o build é o Community e `npm run check:installer` falha se um build Community tiver
`resources/enterprise`. Os instaladores Enterprise não devem ir para um lugar público.

## Workflow de release

[`.github/workflows/release.yml`](../.github/workflows/release.yml) roda só quando disparado à
mão (Actions → Release → Run workflow). Ele gera os instaladores de Windows, macOS e Linux,
confere o tamanho e guarda os arquivos como artefatos do workflow, e monta e testa o pacote npm.
Nada vai para GitHub Releases; o npm só é publicado com `publish_npm` marcado. Os segredos e
variáveis do repositório que ele usa são os da tabela de assinatura, mais `NPM_TOKEN`.

## O que o mantenedor precisa fornecer

- **Windows**: um certificado de assinatura de código (OV/EV `.pfx`) ou uma conta do Azure
  Trusted Signing, configurados como segredos do repositório.
- **macOS**: conta no Apple Developer Program, certificado "Developer ID Application" exportado
  em `.p12` e uma chave de API da App Store Connect para a notarização.
- **npm**: conta no npm com o nome `vvpost` reservado e um token de automação (`NPM_TOKEN`).
- **CLA**: revisão jurídica do texto em [CLA.md](CLA.md), a branch `cla-signatures` e a variável
  de repositório `CLA_ENABLED=true` para ligar o workflow de assinatura.
- **Minutos do GitHub Actions** (ou um runner próprio) para o workflow de release, já que macOS
  só empacota num Mac.
