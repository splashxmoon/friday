/**
 * Who someone is, as the rest of Friday sees them: the shape an account has, wherever it is kept (accounts.ts on the hosted
 * service; on someone's own computer, the one person using it, src/local/identity.ts).
 */
export type Provider = "google" | "github" | "dev" | "email";

export interface Account {
  id: string;
  /** Who vouched for them, and their id there. */
  provider: Provider;
  providerId: string;
  email: string;
  name: string;
  avatar?: string;
  createdAt: number;
  lastSeenAt: number;
}

export const publicAccount = (a: Account) => ({ id: a.id, name: a.name, email: a.email, avatar: a.avatar, provider: a.provider });
export type PublicAccount = ReturnType<typeof publicAccount>;
