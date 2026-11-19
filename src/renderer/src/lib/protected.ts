/**
 * Confirmação antes de disparar num ambiente protegido (docs/security-model.md, Ambientes
 * protegidos): o catálogo marca `protected` pelo arquivo ou pelo nome de produção. Sem ambiente
 * protegido, segue sem perguntar.
 */
export async function confirmProtected(
  confirm: (a: { title: string; message?: string; confirmLabel: string; danger?: boolean }) => Promise<boolean>,
  envs: readonly ({ id: string; name: string; protected?: boolean } | undefined)[],
  what: string
): Promise<boolean> {
  const hit = envs.filter((e): e is { id: string; name: string; protected?: boolean } => !!e?.protected)
  if (!hit.length) return true
  const names = hit.map((e) => e.name).join(', ')
  return confirm({
    title: `${what} em ${hit.length === 1 ? 'ambiente protegido' : 'ambientes protegidos'}?`,
    message: `${names} ${hit.length === 1 ? 'é protegido' : 'são protegidos'} (produção): o disparo vai para o sistema real.`,
    confirmLabel: 'Disparar mesmo assim',
    danger: true
  })
}
