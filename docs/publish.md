# Enviar para… (publicar e exportar a documentação)

O botão **Enviar para…** da Documentação leva a documentação do projeto para fora do VVPost: como
um **site HTML estático** numa pasta (para um portal de parceiros, o GitHub Pages ou o Backstage),
no formato de um **exportador de plugin** (como o MkDocs do Backstage TechDocs) ou para um destino
remoto, como o Confluence Cloud ou o de um **publicador de plugin**, com a conta da própria pessoa. A estrutura das páginas (o que vira
pasta, o que vira página e de onde vem o conteúdo) fica no repositório, no `vvpost.publish.json`, e
vai para o Git com o resto.

O core traz o formato do arquivo, a montagem das páginas, o exportador `html` e os pontos de
extensão. O publicador do Confluence Cloud vem com o VVPost Enterprise, que também guarda o login
corporativo e os destinos que a organização libera. Os exportadores para outros formatos vêm de
plugins (`contributes.exporters`), e os publicadores para outros destinos remotos também
(`contributes.publishers`, [abaixo](#publicadores-de-plugins)).

No CI, `vvpost docs export` gera o site (ou a saída de um exportador de plugin) sem abrir o app:
veja [No CI](#no-ci-vvpost-docs-export).

## O arquivo `vvpost.publish.json`

```json
{
  "$schema": "https://vvpost.dev/schemas/v1/publish.json",
  "targets": [
    {
      "id": "confluence",
      "provider": "confluence-cloud",
      "destination": "catalog:pagamentos",
      "diagrams": "png",
      "structure": [
        {
          "page": "Documentação do projeto",
          "source": "document",
          "children": [
            { "folder": "Guias", "children": [{ "pages": "docs/**/*.md" }] },
            { "page": "Arquitetura", "source": "docs/arquitetura.md#contexto" },
            { "folder": "Referência da API", "children": [{ "each": "connector", "split": "endpoints" }] }
          ]
        }
      ]
    }
  ]
}
```

| Campo | O que faz |
| --- | --- |
| `id` | Nome do destino no arquivo (minúsculas, dígitos, `.`, `_`, `-`). |
| `provider` | Quem atende o destino: `html` (o site estático, do core), o id de um exportador ou publicador de plugin (`mkdocs`, do plugin oficial) ou `confluence-cloud` (Enterprise). |
| `destination` | Num exportador, a pasta de saída, relativa ao workspace e dentro dele (`dist/site`). Num publicador, onde a estrutura começa: no Enterprise, um destino do catálogo da organização (`catalog:<id>`), que fixa o espaço e a página-raiz. |
| `diagrams` | Como os diagramas Mermaid vão: `png`, `svg` ou `code` (o código, sem imagem). Padrão: `svg` no `html` e `png` nos outros. |
| `site` | Opções dos exportadores: `title` (o título do site; padrão, o do `vvpost.docs.json`), `changelog` (a página Mudanças; padrão `true`), `backstage` (Backstage TechDocs) e `baseUrl` (o endereço público, para o `sitemap.xml` e os links canônicos). |
| `structure` | A árvore de pastas e páginas, até 8 níveis e 200 nós. |
| `published` | Escrito pelo app depois de cada publicação: o id, a versão e o hash de cada página no destino, por chave. Faça o commit dele, para a próxima publicação achar as mesmas páginas. |

### Nós da estrutura

| Nó | Vira |
| --- | --- |
| `{ "folder": "Guias", "children": [...] }` | Uma pasta. |
| `{ "page": "Título", "source": "...", "children": [...] }` | Uma página. `source` é `document` (o documento do projeto), um `.md` do workspace (com `#seção` para só um trecho), `connector:<id>` ou `endpoint:<conector>/<endpoint>`. Sem `source`, a página só agrupa as filhas. |
| `{ "pages": "docs/**/*.md", "title": "{{heading}}" }` | Uma página por arquivo do glob, em ordem alfabética. O título é o primeiro título do arquivo (`{{heading}}`) ou o nome dele (`{{file}}`). O documento-fonte do projeto e os arquivos que outro nó já usa ficam de fora. |
| `{ "each": "connector", "split": "endpoints" }` | Uma página por conector, em ordem de nome (`title` aceita `{{name}}` e `{{id}}`; `connectors` limita a lista). Com `split: "endpoints"`, cada endpoint vira uma página filha; com `sections` (padrão), o endpoint fica numa seção da página do conector. |

Cada nó tem uma chave (`key`) que liga a página do repositório à do destino. A chave padrão vem
da origem (`document`, `file:docs/guia.md`, `connector:billing`, `folder:guias`...). Dê uma
`key` explícita quando mudar o título ou a origem de uma página que já foi publicada, para ela
não virar uma página nova.

## No app

1. **Documentação → Enviar para…**. Sem `vvpost.publish.json`, o app cria um com a estrutura de
   partida acima.
2. Escolha o destino e entre com a sua conta. O publicador usa as suas permissões: você só
   publica onde já pode escrever.
3. **Ver o que vai mudar** monta as páginas, desenha os diagramas e compara com o destino, sem
   mudar nada lá. Cada página aparece como nova, com mudança, igual, editada no destino (alguém
   mudou a página depois da última publicação) ou fora da estrutura.
4. Marque o que publicar. Mudança comum vem marcada; página editada no destino e arquivamento só
   vão se você marcar. Página que já existe só muda depois da confirmação.
5. No fim, o app grava os ids no `published` do arquivo. Se o arquivo mudou no meio (um `git
   pull`, por exemplo), ele avisa em vez de sobrescrever.

O conteúdo passa pelo Secret Sanitizer antes de sair: nenhum valor de segredo do cofre vai para
o destino. Links entre arquivos `.md` publicados viram links entre as páginas, e imagens do
workspace viram anexos.

## Site HTML estático (`html`)

O exportador `html` grava a documentação como um site que não precisa de servidor nem de nada
externo: abre direto do disco e serve em qualquer hospedagem estática.

```json
{
  "id": "portal",
  "provider": "html",
  "destination": "dist/portal",
  "site": { "baseUrl": "https://parceiros.acme.dev/pagamentos" },
  "structure": [{ "page": "Pagamentos", "source": "document", "children": [{ "folder": "Referência da API", "children": [{ "each": "connector", "split": "endpoints" }] }] }]
}
```

- Uma página `.html` por página da estrutura (a primeira é o `index.html`), com nomes estáveis
  pela chave do nó (`guias-inicio.html`, `connector-billing.html`), navegação lateral com as
  pastas, sumário da página, anterior e próxima, e busca no próprio site (tecla `/`).
- Os diagramas viram imagens em `assets/` (SVG, ou PNG com `"diagrams": "png"`), com o código
  Mermaid embaixo; imagens do workspace também vão para `assets/`.
- A cor de destaque, o logo, a versão e a organização vêm do modelo do projeto (`vvpost.docs.json`).
- HTML cru dos arquivos `.md` aparece como texto, e links `javascript:` saem: o site nunca
  interpreta o que veio dos arquivos. Nenhum valor de segredo entra (o mesmo Secret Sanitizer do
  resto da documentação).
- Com `site.baseUrl`, o site ganha `sitemap.xml` e `<link rel="canonical">`.

### Página Mudanças

A pasta guarda o estado da exportação no `vvpost-site.json`: o hash de cada página e de cada
endpoint e o que mudou em cada exportação. A seguinte compara com ele e acrescenta à página
**Mudanças** (`mudancas.html`) os endpoints e as páginas novos, alterados e removidos, com o nome
da versão quando houver (`vvpost docs export --label v2.3.0`). Uma exportação sem mudança não cria
entrada. No CI, guarde a pasta entre as execuções (o artefato do último deploy, o branch
`gh-pages`) para o histórico continuar; `"site": { "changelog": false }` tira a página.

### Exportar pelo app

O mesmo **Enviar para…**: sem `vvpost.publish.json`, escolha **Site HTML** e a pasta (padrão
`dist/site`). Não há conta. **Ver o que vai mudar** compara com a exportação anterior na pasta:
página nova, que muda (com o diff), igual, editada à mão na pasta depois da última exportação ou
fora da estrutura. Como num destino remoto, página que já existe só muda com confirmação, e o que
saiu da estrutura só é apagado se você marcar. No fim, **Abrir a pasta**. O `vvpost.publish.json`
não muda: o estado fica no `vvpost-site.json` da pasta.

A pasta precisa estar vazia na primeira exportação (arquivos ocultos, como `.git`, não contam):
o VVPost não sobrescreve uma pasta que não criou. Depois, ele só apaga o que ele mesmo gravou.

### No CI (`vvpost docs export`)

```sh
npx vvpost docs export --workspace . --target portal --label "$GITHUB_REF_NAME"
```

| Opção | O que faz |
| --- | --- |
| `--target <id>` | O destino do `vvpost.publish.json` (com um exportador). Sem ele, o único exportável; sem o arquivo, um site `html` com a estrutura de partida em `dist/site`. |
| `--out <pasta>` | Outra pasta de saída (relativa à pasta atual). |
| `--label <versão>` | Nome desta versão na página Mudanças. |
| `--force` | Sobrescreve as páginas editadas à mão na pasta. Sem ele, o comando sai com 1 e lista as páginas. |
| `--no-plugins` | Só o exportador `html`. |
| `--json -` | O resultado em JSON no stdout. |

Os diagramas viram imagem quando o executável do VVPost está por perto (o app instalado, ou
`VVPOST_ELECTRON` apontando para ele). Sem ele (o pacote npm, um runner de CI, o worker do VVBuilder),
o site `html` leva o próprio `assets/mermaid.min.js` e o navegador desenha os diagramas, sem CDN e só
nas páginas que têm diagrama; o código continua em "Código do diagrama". Os exportadores de plugin
recebem só o código Mermaid. Os publicadores remotos (Confluence Cloud) continuam só no app, com a confirmação de cada
página.

### Pelo agente (MCP)

`export_docs` com `format: "site"` faz o mesmo que o `vvpost docs export` com o exportador `html`:
o destino `html` do `vvpost.publish.json` (`target` escolhe entre vários) ou, sem o arquivo, o site
com a estrutura de partida em `dist/site`. `out` troca a pasta, sempre dentro do projeto, e `label`
nomeia a versão na página Mudanças. Uma página editada à mão na pasta faz a chamada falhar com
`CONFLICT`; `force: true` sobrescreve. O MCP não carrega plugins, então o destino de um exportador
de plugin sai pelo CLI, e os publicadores remotos seguem só no app.

## MkDocs e Backstage TechDocs

O plugin oficial **MkDocs e Backstage TechDocs** (`vvpost-plugin-mkdocs`, ligado no Extensions
Hub) traz o exportador `mkdocs`: o `mkdocs.yml` com a navegação da estrutura e uma página Markdown
por página em `docs/`, com os diagramas e as imagens em `docs/assets/`, os alertas como
admonitions e a página Mudanças. É o formato que o Backstage TechDocs gera.

```json
{ "id": "techdocs", "provider": "mkdocs", "destination": "techdocs", "site": { "backstage": true }, "structure": [...] }
```

Com `site.backstage`, o `mkdocs.yml` já usa o plugin `techdocs-core`. Aponte o
`catalog-info.yaml` do componente para a pasta (`backstage.io/techdocs-ref: dir:./techdocs`) e o
TechDocs gera e publica como faz com qualquer projeto MkDocs. No CI:
`vvpost docs export --target techdocs` e depois `techdocs-cli generate` e `publish`.

Para publicar o site `html` pronto, sem o build do MkDocs, `"site": { "backstage": true }` no
destino `html` grava também o `techdocs_metadata.json`, que o `techdocs-cli publish --directory`
pede. Nesse caminho o TechDocs mostra as páginas do site como elas são, sem o tema dele; o
`mkdocs` é o caminho recomendado para o Backstage.

## Exportadores de plugins

Um plugin acrescenta formatos com `contributes.exporters` no manifesto e `exporters[id].export(ctx)`
no código ([plugins.md](plugins.md#exportadores-da-documentação)). O exportador roda no processo do
plugin, com as mesmas permissões dos nós: recebe em `ctx.bundle` as páginas já montadas e sem
segredos (a mesma árvore dos publicadores), o histórico em `ctx.changelog`, e devolve os arquivos.
Quem grava é o VVPost, só dentro da pasta de saída; caminhos com `..`, absolutos ou o
`vvpost-site.json` são recusados.

## Publicadores de plugins

Um plugin também publica num destino remoto (uma wiki, um portal de documentação, o Notion) com
`contributes.publishers` no manifesto e `publishers[id]` no código, com `plan(ctx)`, `publish(ctx)` e
`session(ctx)` opcional ([plugins.md](plugins.md#publicadores-da-documentação)). O plugin monta o
plano e publica; o VVPost cuida do que é da pessoa:

- **A credencial.** No **Enviar para…**, a pessoa cola o token pedido pelo manifesto (o `auth.label`,
  com o link de `auth.help`). Ele vai direto ao cofre local, cifrado e fora de qualquer projeto, e
  vale para esse publicador em qualquer workspace. **Sair** apaga. Um token que a `session` do plugin
  recusa não fica guardado.
- **A rede.** O plugin só fala com o destino por `ctx.http`, e só com os `hosts` do manifesto, por
  HTTPS (HTTP só no loopback). O VVPost põe a auth em cada requisição, troca qualquer `Authorization`
  ou `Cookie` que o plugin tenha posto, não segue redirecionamentos (a auth não vai para outro host) e
  tira o token do que volta. O plugin nunca vê a credencial. As requisições usam o proxy e as CAs das
  configurações de HTTP e não entram no histórico.
- **A confirmação.** O plano e o resultado são conferidos campo a campo, só com as chaves do pacote.
  Uma página que o plugin diz ter mudado sem a confirmação da pessoa vira falha no resultado e não
  é gravada no `vvpost.publish.json`. O hash gravado é o do pacote.

A organização desliga os publicadores de plugins junto com os plugins (o recurso `plugins` dos
[recursos desligados](security-model.md#recursos-desligados)). Um publicador do módulo Enterprise
com o mesmo id vence o do plugin.

## Ponto de extensão para publicadores

Um publicador implementa `DocsPublisher` (`@vvpost/core/docs/publish`) e chega ao app pelo
`publishers` da extensão do Control Plane (o mesmo ponto de extensão do módulo Enterprise) ou de um
plugin, montado por `pluginPublisher` a partir de `contributes.publishers`:

```ts
interface DocsPublisher {
  id: string
  title: string
  session(target): Promise<PublisherSession>
  signIn?(target, ctx): Promise<PublisherSession>
  signOut?(target): Promise<void>
  plan(bundle, ctx): Promise<PublishPlan>
  publish(bundle, plan, approval, ctx): Promise<PublishResult>
}
```

- O publicador recebe um `PublishBundle` neutro: a árvore de nós com o título, o hash e os
  blocos de cada página (títulos com âncora, parágrafos, listas, tabelas, código, alertas,
  diagramas, links entre páginas e imagens), mais os anexos. Ele não lê o workspace nem
  interpreta Markdown.
- `plan` só lê o destino. `publish` recebe a aprovação da pessoa (`update`, `conflicts`,
  `archive`) e não pode mudar nada fora dela.
- A sessão que volta para a interface é copiada campo a campo (`status`, `account`,
  `destination`, `message` e, para um publicador que entra com uma credencial colada,
  `credential: { label, help }`): token nenhum sai do main process. Com `credential`, o diálogo
  mostra o campo, e `signIn` recebe o valor em `ctx.credential`.
- Cada publicação vira um evento `docsPublish` na atividade do Control Plane, com as contagens.
