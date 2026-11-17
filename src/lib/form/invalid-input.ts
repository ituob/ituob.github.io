/**
 * Pending invalid input: a field whose text is not yet a valid value keeps its path here (path -> message)
 * until it becomes valid. An empty message clears that path and everything beneath it, so clearing a list
 * clears its items' entries (`a`, `a.b`, `a[1]`) but never a sibling that merely shares a prefix (`ab`).
 */
export type InvalidInput = Record<string, string>;
export function applyInvalid(errors: InvalidInput, path: string, message: string): void {
  if (message) { errors[path] = message; return; }
  for (const key of Object.keys(errors)) if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) delete errors[key];
}
