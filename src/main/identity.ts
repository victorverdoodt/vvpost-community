import { readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { disabledFeatures } from '@vvpost/core/policy/features'
import type { EnterpriseIdentity, EnterprisePolicy, IdentityState, LocalProfile, WorkspaceResult } from '@shared/ipc'

/**
 * Identidade. O core cuida só do perfil local (nome de exibição
 * da estação, sem conta nem servidor). Login, organizações e permissões vêm de um provedor que o
 * módulo Enterprise registra; sem ele, `enterprise` é null e nada na interface depende de login.
 * Tokens e sessão ficam no provedor, no processo principal: o renderer só vê este estado.
 */
export interface IdentityProvider {
  state(): EnterpriseIdentity
  signIn(): Promise<void>
  signOut(): Promise<void>
  switchOrganization(id: string): Promise<void>
  /** Avisa quando a sessão muda sozinha (expirou, renovou). Devolve o cancelamento. */
  onChange?(listener: () => void): () => void
}

const PROFILE_FILE = 'profile.json'
const MAX_NAME = 60

let provider: IdentityProvider | null = null
let providerOff: (() => void) | undefined
const listeners = new Set<(state: IdentityState) => void>()

export function registerIdentityProvider(next: IdentityProvider | null): void {
  providerOff?.()
  provider = next
  providerOff = next?.onChange?.(notify)
  notify()
}

export function onIdentityChange(listener: (state: IdentityState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let profileDir = ''
export function setProfileDir(dir: string): void {
  profileDir = dir
}

/** O estado mudou fora do provedor (os recursos desligados pela organização): a interface relê. */
export function refreshIdentity(): void {
  notify()
}

function notify(): void {
  if (!profileDir) return
  const state = identityState()
  for (const l of listeners) l(state)
}

export function identityState(): IdentityState {
  return { profile: readProfile(profileDir), enterprise: provider?.state() ?? null, features: disabledFeatures() }
}

/** A política efetiva do Control Plane, com a sessão corporativa aberta; sem módulo ou sem sessão, undefined. */
export function enterprisePolicy(): EnterprisePolicy | undefined {
  return provider?.state().policy
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1)
  return letters.map((w) => [...w][0]!.toLocaleUpperCase('pt-BR')).join('') || '?'
}

function defaultName(): string {
  try {
    return userInfo().username || 'Usuário local'
  } catch {
    return 'Usuário local'
  }
}

export function readProfile(dir: string): LocalProfile {
  let displayName = ''
  try {
    const raw = JSON.parse(readFileSync(join(dir, PROFILE_FILE), 'utf8')) as { displayName?: unknown }
    if (typeof raw.displayName === 'string') displayName = raw.displayName.trim().slice(0, MAX_NAME)
  } catch {
    // Sem perfil gravado: o nome do usuário do sistema.
  }
  displayName ||= defaultName()
  return { displayName, initials: initials(displayName) }
}

export function writeProfile(dir: string, input: unknown): LocalProfile {
  const name = (input as { displayName?: unknown } | null)?.displayName
  if (typeof name !== 'string' || !name.trim()) throw new Error('Informe um nome de exibição.')
  const displayName = name.trim().replace(/\s+/g, ' ')
  if ([...displayName].length > MAX_NAME) throw new Error(`O nome de exibição tem no máximo ${MAX_NAME} caracteres.`)
  writeFileSync(join(dir, PROFILE_FILE), `${JSON.stringify({ displayName }, null, 2)}\n`)
  return { displayName, initials: initials(displayName) }
}

async function result(task: () => Promise<void> | void): Promise<WorkspaceResult<IdentityState>> {
  try {
    await task()
    notify()
    return { ok: true, value: identityState() }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

function enterprise(): IdentityProvider {
  if (!provider) throw new Error('Login corporativo indisponível: o módulo Enterprise não está instalado.')
  return provider
}

export const setLocalProfile = (input: unknown) => result(() => void writeProfile(profileDir, input))
export const signIn = () => result(() => enterprise().signIn())
export const signOut = () => result(() => enterprise().signOut())
export const switchOrganization = (id: unknown) =>
  result(() => {
    if (typeof id !== 'string' || !id) throw new Error('Organização inválida.')
    return enterprise().switchOrganization(id)
  })
