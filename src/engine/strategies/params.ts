/**
 * Parameter validation shared by every strategy.
 *
 * A strategy runs unattended for hours against a real account, so a bad
 * parameter has to be rejected at `init` time, in front of the caller, while
 * there is still someone to read the message. Every error here names the
 * parameter and the fix rather than describing the failure.
 */

export function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`"${key}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function requireDecimal(params: Record<string, unknown>, key: string): string {
  const value = String(params[key] ?? '');
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new Error(`"${key}" must be a positive decimal string, e.g. "0.5".`);
  }
  return value;
}

/**
 * Same shape as `requireDecimal`, but absent is a legal answer.
 *
 * Returns null for undefined/null so callers can branch on presence without
 * re-checking the raw params object.
 */
export function optionalDecimal(params: Record<string, unknown>, key: string): string | null {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === '') return null;
  return requireDecimal(params, key);
}

export function requireInt(
  params: Record<string, unknown>,
  key: string,
  bounds: { min: number; max: number },
): number {
  const value = Number(params[key]);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`"${key}" must be an integer between ${bounds.min} and ${bounds.max}.`);
  }
  return value;
}

export function requireNumber(
  params: Record<string, unknown>,
  key: string,
  bounds: { min: number; max: number },
): number {
  const value = Number(params[key]);
  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`"${key}" must be a number between ${bounds.min} and ${bounds.max}.`);
  }
  return value;
}

export function requireEnum<T extends readonly string[]>(
  params: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const value = String(params[key] ?? '');
  if (!allowed.includes(value)) {
    throw new Error(`"${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

/** True when the caller supplied a value at all, whatever its type. */
export function isPresent(params: Record<string, unknown>, key: string): boolean {
  const raw = params[key];
  return raw !== undefined && raw !== null && raw !== '';
}
