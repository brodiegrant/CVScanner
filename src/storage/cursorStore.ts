export type Cursor = {
  accountEmail: string;
  label: string;
  lastSuccessInternalDate: number;
};

export interface CursorStore {
  getCursor(accountEmail: string, label: string): Cursor | null;
  setCursor(accountEmail: string, label: string, lastSuccessInternalDate: number): void;
  isProcessed(accountEmail: string, label: string, messageId: string, lookbackDays: number): boolean;
  markProcessed(accountEmail: string, label: string, messageId: string, internalDate: number): void;
  pruneProcessed(accountEmail: string, label: string, lookbackDays: number): void;
}
