# Projeto de demonstração

Projeto VVPost pronto para conhecer o app, no formato de fluxos: uma
base corporativa com OAuth2 e duas bases filhas com herança e overrides (cada uma um fluxo-base em
`flows/<id>/`, com um fluxo de requisição por endpoint), cenários com sucesso e falha, um fluxo de checkout, uma cobrança PIX que abre como requisição (visão Simples), dois ambientes (com um segredo pendente em Staging) e
a documentação do projeto montada com o modelo C4, um dos modelos disponíveis (`vvpost.docs.json`, `docs/projeto.md`, um guia em
`docs/guia-de-integracao.md` e o diagrama `docs/diagramas/cobranca.mmd`). As capturas da
documentação saem deste projeto (`node scripts/docs-screenshots.mjs`).

A API de mentira roda com `node scripts/demo-server.mjs` (porta 4010) e responde ao que os
endpoints, os cenários e os fluxos chamam. Para usar, copie esta pasta para fora do repositório e
abra a cópia no VVPost: o app grava `.vvpost/` e segredos locais dentro do projeto.

O segredo `CLIENT_SECRET` de Development é `demo-secret` (configure-o pelo módulo Secrets);
`PAYMENTS_TOKEN` de Staging fica pendente de propósito.
