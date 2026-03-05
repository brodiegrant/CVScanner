export type StoredToken = {
  accountEmail: string;
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
};

export interface TokenStore {
  upsert(token: StoredToken): void;
  get(accountEmail: string): StoredToken | null;
}
