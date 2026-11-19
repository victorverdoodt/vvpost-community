// Tokens da marca e do produto (docs/brand.md): o contrato do frontend no formato W3C DTCG, o
// contraste e o código conferido contra eles. Chunk carregado sob demanda pelo app, pelo CLI e pelo MCP.
export { BRAND_DIR, findTokenFiles, loadBrand, TOKENS_SUFFIX, type BrandLoad } from './load'
export { brandScanContext, parseObjectLiteral, scanBrandSource, type BrandScanContext } from './scan'
export {
  BASE_MODE,
  colorDistance,
  contrastRatio,
  formatTokenValue,
  parseColor,
  parseDimension,
  parseTokensFile,
  toHex,
  type BrandCode,
  type BrandFile,
  type BrandItem,
  type BrandToken,
  type ContrastPair,
  type ContrastResult,
  type Rgba
} from './tokens'
