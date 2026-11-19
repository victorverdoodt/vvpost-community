## O que muda

<!-- O que este PR faz e por quê. Link da issue, se houver (Closes #123). -->

## Como foi verificado

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:e2e` (ou os E2E afetados)
- [ ] `npm run bench` sem regressão nas metas de `perf-budgets.json`

<!-- Para mudanças de interface, inclua um print. -->

## Checklist

- [ ] Nenhum caminho novo de saída sem caso em `test/secret-leaks.test.ts`
- [ ] Documentação em `docs/` atualizada no mesmo PR
- [ ] Nenhuma lógica do módulo Enterprise neste repositório (só pontos de extensão)
