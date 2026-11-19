import { useEffect, useState } from 'react'

/** Altura (px CSS) abaixo da qual a janela é baixa: zoom de 150% ou notebook. */
export const SHORT_WINDOW = 620

export const isShortWindow = (): boolean => window.innerHeight < SHORT_WINDOW

/** Janela baixa agora, acompanhando o redimensionamento e o zoom. */
export function useShortWindow(): boolean {
  const [short, setShort] = useState(isShortWindow)
  useEffect(() => {
    const update = () => setShort(isShortWindow())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return short
}
