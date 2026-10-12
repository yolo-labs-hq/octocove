/** Cursor keys are separate from receipt/runner keys. Deadlines are UTC epoch milliseconds. */
export interface AuditCursorKeys {
  activeKeyId: string;
  keys: Record<string, { secret: string; verifyUntil?: number }>;
}
export class AuditCursorKeyError extends Error {
  constructor() { super('audit-unavailable'); }
}
export function validateAuditCursorKeys(config: AuditCursorKeys): AuditCursorKeys {
  if (!config || typeof config.activeKeyId !== 'string' || !config.keys ||
      typeof config.keys !== 'object' || Array.isArray(config.keys) ||
      !Object.hasOwn(config.keys, config.activeKeyId)) throw new AuditCursorKeyError();
  for (const [id, key] of Object.entries(config.keys)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !key || typeof key.secret !== 'string' || !key.secret ||
        (id === config.activeKeyId ? key.verifyUntil !== undefined :
          !Number.isSafeInteger(key.verifyUntil) || key.verifyUntil! < 0)) throw new AuditCursorKeyError();
  }
  return config;
}
export function auditCursorKeys(env: {
  AUDIT_CURSOR_SECRET?: string; AUDIT_CURSOR_KEY_ID?: string; AUDIT_CURSOR_KEYRING?: string;
}): string | AuditCursorKeys {
  // A partially configured ring must never fall back to the single AUDIT_CURSOR_SECRET.
  if (env.AUDIT_CURSOR_KEY_ID !== undefined || env.AUDIT_CURSOR_KEYRING !== undefined) {
    try {
      return validateAuditCursorKeys({ activeKeyId: env.AUDIT_CURSOR_KEY_ID!, keys: JSON.parse(env.AUDIT_CURSOR_KEYRING!) });
    } catch { throw new AuditCursorKeyError(); }
  }
  if (!env.AUDIT_CURSOR_SECRET) throw new AuditCursorKeyError();
  return env.AUDIT_CURSOR_SECRET;
}
export function cursorVerificationSecret(config: AuditCursorKeys, id: unknown, now = Date.now()): string | undefined {
  if (typeof id !== 'string' || !Object.hasOwn(config.keys, id)) return undefined;
  const key = config.keys[id]!;
  return id === config.activeKeyId || now < key.verifyUntil! ? key.secret : undefined;
}
