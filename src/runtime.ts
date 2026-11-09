/** Single account instance shared by the Source kind, routes, and the settings UI. */
import type { Account } from './account.ts'

let current: Account | undefined

export const setAccount = (account: Account | undefined): void => { current = account }
export const currentAccount = (): Account | undefined => current
