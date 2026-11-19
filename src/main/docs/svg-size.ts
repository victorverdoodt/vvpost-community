/** Tamanho do SVG pelo width/height da raiz ou pelo viewBox. */
export function svgSize(svg: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0]
  if (!root) return null
  const attr = (name: string) => new RegExp(`\\s${name}="([^"]+)"`, 'i').exec(root)?.[1]
  const px = (v?: string) => (v && /^\d+(\.\d+)?(px)?$/.test(v.trim()) ? Number.parseFloat(v) : undefined)
  const box = attr('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const fromBox = box?.length === 4 && box.every(Number.isFinite) ? { width: box[2]!, height: box[3]! } : undefined
  // O Mermaid põe width="100%" e max-width no style; aí vale o viewBox.
  const maxWidth = /max-width:\s*([\d.]+)px/i.exec(attr('style') ?? '')?.[1]
  const width = px(attr('width')) ?? (maxWidth ? Number(maxWidth) : undefined) ?? fromBox?.width
  const height = px(attr('height')) ?? (fromBox && width ? (fromBox.height * width) / fromBox.width : undefined)
  if (!width || !height || width <= 0 || height <= 0) return null
  return { width, height }
}
