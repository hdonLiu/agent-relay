import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function fail(code, status = 400, message = code) {
  throw Object.assign(new Error(message), { code, status });
}

export function identifier(value, name = 'id') {
  if (typeof value !== 'string' || !value.length || value.length > 256 ||
      value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) {
    fail('INVALID_ARGUMENTS', 400, `Invalid ${name}`);
  }
  return value;
}

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export const token = () => randomBytes(32).toString('base64url');
export const id = () => randomUUID();
