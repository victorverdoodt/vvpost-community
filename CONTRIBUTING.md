# Contribuindo com o VVPost

Obrigado pelo interesse! Este guia explica como propor mudanças no VVPost Community. Ao
participar, você concorda em seguir o [código de conduta](CODE_OF_CONDUCT.md).

## Antes de começar

- **Bugs:** procure nas [issues](https://github.com/victorverdoodt/vvpost-community/issues) se já foi
  relatado; se não, abra uma com o modelo de bug, passos para reproduzir e a versão.
- **Recursos novos:** abra uma issue com o modelo de sugestão antes de escrever código grande.
  Assim combinamos o desenho e evitamos trabalho perdido. A [arquitetura](docs/architecture.md) e o
  [modelo de segurança](docs/security-model.md) explicam os contratos que o código segue.
- **Vulnerabilidades:** nunca em issue pública. Veja [SECURITY.md](SECURITY.md).

## Ambiente de desenvolvimento

Requisitos: Node.js 22.19+, Git e, para o nó Python, Python 3.

```bash
git clone https://github.com/victorverdoodt/vvpost-community.git
cd vvpost-community
npm ci
npm run dev
```

A organização do código e todos os comandos estão em [docs/development.md](docs/development.md).

## Antes de abrir o PR

Rode o mesmo que o CI roda:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e   # no Linux sem display: xvfb-run -a npm run test:e2e
npm run bench      # no Linux sem display: xvfb-run -a npm run bench
```

Uma meta de `perf-budgets.json` com `enforce: true` reprova o build. Se a sua mudança mexe no
cold start ou na RAM em repouso, diga no PR o antes e o depois do benchmark.

## Regras do projeto

Algumas regras sustentam as garantias do VVPost; o PR que as quebra não entra:

- **Segredos nunca saem em claro.** Quem cria um caminho de saída novo (arquivo, IPC, log, rede,
  resposta para a IA) acrescenta o caso em `test/secret-leaks.test.ts`
  ([garantias](docs/security-model.md#garantias-contra-vazamento-de-segredos)).
- **O motor é Node puro.** `packages/core` não importa Electron nem o renderer, e
  `test/core-boundary.test.ts` confere isso. O app, o CLI e o MCP chamam o mesmo motor.
- **IPC explícito.** Todo canal novo é declarado em `src/shared/ipc.ts` e exposto no preload. O
  renderer roda com `sandbox` e `contextIsolation`, sem `nodeIntegration`.
- **Schemas versionados.** Mudança incompatível num schema exige versão nova e migração
  ([versionamento](docs/architecture.md#versionamento-dos-esquemas)).
- **Interface pelo design system.** Componentes e tokens de
  `src/renderer/src/design-system` (`tokens/tokens.css` é a única fonte de cores, fontes e raios); nada
  de cor ou botão feito à mão.
- **Sem lógica proprietária.** O core só define pontos de extensão para o módulo Enterprise
  ([pontos de extensão](docs/architecture.md#pontos-de-extensão-para-o-módulo-enterprise)); regra de negócio
  comercial não entra neste repositório.

## Commits e pull requests

- Um PR por assunto, pequeno o bastante para revisar. Mudanças de interface trazem um print.
- Mensagens de commit e textos do projeto em português, descrevendo o que muda e por quê.
- Atualize a documentação no mesmo PR: o guia em `docs/` que o recurso afeta.
- Preencha o modelo de PR, inclusive o que foi verificado.

## Licença das contribuições

O VVPost Community é Apache 2.0. Ao contribuir, você licencia a sua contribuição nos mesmos
termos. O
projeto pede a assinatura de um CLA (Contributor License Agreement, no modelo do Apache ICLA)
antes do primeiro merge de quem contribui de fora. O texto e o passo a passo estão em
[docs/CLA.md](docs/CLA.md): no primeiro PR, um bot pede que você responda com
`Li o CLA e concordo com os termos.`, e a assinatura vale para os próximos PRs.
