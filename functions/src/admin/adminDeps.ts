/**
 * Injectable Admin-SDK surface for the vc51.9A6-B admin callables.
 *
 * Handlers never touch firebase-admin directly — they receive this
 * narrow interface so the full authorization/behavior matrix runs
 * against an in-memory mock (tools/test-adminCallables.mjs) and the
 * production implementation (buildFirestoreAdminDeps in callables.ts)
 * stays a thin, obviously-correct adapter.
 */

export interface AdminDocSnapshot {
  exists: boolean;
  data?: Record<string, unknown>;
}

export interface AdminTransaction {
  get(path: string): Promise<AdminDocSnapshot>;
  /** Field-merge update; MUST fail if the document does not exist. */
  update(path: string, fields: Record<string, unknown>): void;
  /** Create; MUST fail if the document already exists. */
  create(path: string, data: Record<string, unknown>): void;
}

export interface ListedDoc {
  id: string;
  data: Record<string, unknown>;
}

export interface AdminDeps {
  getDoc(path: string): Promise<AdminDocSnapshot>;
  runTransaction<T>(fn: (tx: AdminTransaction) => Promise<T>): Promise<T>;
  /** Documents of `collection` ordered by DOCUMENT ID. */
  listDocsById(collection: string, opts: {
    direction: 'asc' | 'desc';
    limit: number;
    startAfterId?: string;
  }): Promise<ListedDoc[]>;
  /** Time-sortable unique audit id (zero-padded ms + random suffix). */
  newAuditId(): string;
  /** Opaque server-timestamp sentinel (FieldValue.serverTimestamp()). */
  serverTimestamp(): unknown;
  nowMs(): number;
}

/**
 * Typed handler failure. The onCall wrapper maps `code` onto the
 * HttpsError code and always carries the machine-readable `adminCode`
 * in details so the Dashboard service can normalize without string
 * matching on messages.
 */
export type AdminCallErrorCode =
  | 'unauthenticated'
  | 'permission-denied'
  | 'invalid-argument'
  | 'failed-precondition'
  | 'not-found'
  | 'already-exists'
  | 'internal';

export class AdminCallError extends Error {
  readonly code: AdminCallErrorCode;
  readonly adminCode: string;
  constructor(code: AdminCallErrorCode, adminCode: string, message?: string) {
    super(message ?? adminCode);
    this.code = code;
    this.adminCode = adminCode;
  }
}
