/*
 * Formas que os componentes de identidade leem. São as mesmas de IdentityState['enterprise']
 * (src/shared/ipc.ts), escritas aqui para o design system não depender do IPC.
 */
export type AuthProvider = 'azureAd' | 'okta' | 'awsIam'

export interface OrganizationRef {
  id: string
  name: string
}

/** Papéis efetivos; project "*" é a organização inteira. */
export interface ProjectPermission {
  project: string
  roles: string[]
}

export const PROVIDER_NAME: Record<AuthProvider, string> = {
  azureAd: 'Microsoft Entra ID',
  okta: 'Okta',
  awsIam: 'AWS IAM Identity Center'
}
