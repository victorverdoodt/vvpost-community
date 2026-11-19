# Loja API

API de pedidos da Loja: produtos, pedidos, cancelamento e cotação de frete com as transportadoras
parceiras (TransNorte e, como reserva, EntregaJá).

```bash
npm start   # http://localhost:3000
npm test
```

- A API, as APIs das transportadoras e a documentação ficam no projeto do VVPost em [`api/`](api/):
  catálogo (`api/flows/`), páginas (`api/docs/`) e o documento do projeto (`api/docs/projeto.md`).
- `vvpost docs --workspace api --out -` gera o documento; `vvpost validate --workspace api` confere.
