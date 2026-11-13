import { description, type AttributeDescription } from './form/description';
import { blankState, toInstance, type FormNode } from './form/model';
import { AMENDMENT_CLASSES, validateClass, type SchemaIssue } from './schema.validators.generated';

export const amendmentClasses = AMENDMENT_CLASSES.filter(name => !!description.classes[name]);
export const actionTypes = (description.enums.ActionType ?? []).filter(type => type !== 'SEED');
export function initialValue(attr: AttributeDescription): unknown {
  if (attr.collection) return [];
  if (attr.kind === 'class') return toInstance(blankState(attr.type));
  if (attr.kind === 'enum') return description.enums[attr.type]?.[0] ?? '';
  if (attr.type === 'Boolean') return false;
  if (attr.type === 'Integer' || attr.type === 'Float') return 0;
  if (attr.type === 'Hash') return {};
  return '';
}
export function actionPayload(type: string, node: FormNode, existing: Record<string, unknown> = {}) {
  return { ...existing, type, data: toInstance(node) };
}
export function payloadErrors(payload: Record<string, unknown>): SchemaIssue[] {
  const data = payload.data as Record<string, unknown> | undefined;
  const errors = validateClass('RegisterChange', { ...payload, identifier: payload.identifier ?? { code: 'pending' } });
  if (data && typeof data._class === 'string' && amendmentClasses.includes(data._class)) {
    errors.push(...validateClass(data._class, data, 'data'));
  } else errors.push({ path: 'data._class', code: 'enum', message: 'Select an ontology amendment class' });
  return errors;
}
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly errors: SchemaIssue[] = []) { super(message); }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let result: Record<string, unknown>;
  try { result = await response.json(); } catch { throw new ApiError('The server did not return JSON. Sign in or check the service connection.', response.status); }
  if (!response.ok || result.ok !== true) {
    const message = response.status === 401 ? 'Sign in to access your submissions.' : response.status === 403 ? 'Access denied. Check your verified membership or ITU reviewer permissions.' : String(result.error ?? 'Request failed');
    throw new ApiError(message, response.status, Array.isArray(result.errors) ? result.errors as SchemaIssue[] : []);
  }
  return result as T;
}

/** Revision validation is stored as a stage report, while HTTP 422 uses an errors array. */
export function revisionErrors(validation: string): SchemaIssue[] {
  const report = JSON.parse(validation || '{}');
  return Array.isArray(report) ? report : [...(report.stage1 ?? []), ...(report.stage2 ?? [])];
}
