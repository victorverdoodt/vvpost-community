/**
 * Diagramas da documentação desenhados só perto da tela e soltos quando ficam longe.
 *
 * Num documento grande (o "Projeto inteiro" de um projeto com 250 diagramas e 700 tabelas), desenhar
 * todos os diagramas de uma vez levava o renderer a mais de 2 GB: cada SVG do Mermaid custa ~10 MB
 * nativos no Blink (layout, estilo e raster), e o heap JS quase não muda. Aqui cada diagrama é um
 * lugar reservado que ganha o SVG ao chegar perto da área visível do seu rolador e o perde (guardando a
 * altura, para a rolagem não pular) quando se afasta. O SVG desenhado fica num cache pequeno por fonte:
 * voltar a um diagrama não roda o Mermaid de novo.
 */

/** Quanto antes de entrar na tela o diagrama começa a ser desenhado (e até onde ele fica depois de sair). */
export const DIAGRAM_MARGIN_PX = 1200

export interface DiagramSlot {
  /** Chegou perto da tela: desenhe. */
  show(): void
  /** Ficou longe: solte o SVG. */
  hide(): void
}

/** O rolador mais próximo (overflow auto/scroll); sem ele, a janela. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}

const observers = new Map<HTMLElement | null, IntersectionObserver>()
const slots = new WeakMap<Element, DiagramSlot>()
const watched = new Map<HTMLElement | null, number>()

function observerFor(root: HTMLElement | null): IntersectionObserver {
  let observer = observers.get(root)
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const slot = slots.get(entry.target)
          if (!slot) continue
          if (entry.isIntersecting) slot.show()
          else slot.hide()
        }
      },
      { root, rootMargin: `${DIAGRAM_MARGIN_PX}px 0px` }
    )
    observers.set(root, observer)
  }
  return observer
}

/**
 * Acompanha um lugar de diagrama: show quando ele chega perto da área visível, hide quando se
 * afasta. Um módulo oculto (display: none) não desenha nada. Sem IntersectionObserver (testes),
 * desenha na hora e nunca solta. Devolve a função que para de acompanhar.
 */
export function watchDiagram(el: HTMLElement, slot: DiagramSlot): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    slot.show()
    return () => undefined
  }
  // O rolador só existe depois que o elemento está no documento; antes disso, a janela.
  const root = el.isConnected ? scrollParent(el) : null
  const observer = observerFor(root)
  slots.set(el, slot)
  observer.observe(el)
  watched.set(root, (watched.get(root) ?? 0) + 1)
  return () => {
    observer.unobserve(el)
    slots.delete(el)
    const left = (watched.get(root) ?? 1) - 1
    if (left > 0) watched.set(root, left)
    else {
      // Rolador fechado (o módulo saiu): o observer dele sai junto.
      watched.delete(root)
      observer.disconnect()
      observers.delete(root)
    }
  }
}

/** Guarda a altura atual antes de soltar o conteúdo, para a rolagem não pular. */
export function keepHeight(el: HTMLElement): void {
  const h = el.getBoundingClientRect().height
  if (h > 0) el.style.minHeight = `${Math.round(h)}px`
}
