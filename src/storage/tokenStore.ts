export type StoredToken = {
  accountEmail: string;
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
};

export type TokenUpdate = {
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: number;
};

export interface TokenStore {
  upsert(token: StoredToken): void;
  merge(accountEmail: string, update: TokenUpdate): void;
  mergeUpsert(accountEmail: string, patch: TokenUpdate): void;
  get(accountEmail: string): StoredToken | null;
}
