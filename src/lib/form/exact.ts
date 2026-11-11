import { YamlTimestamp } from "./yaml-io.ts";

/**
 * Strict structural equality for stored instances. Stricter than deep-equal:
 * key ORDER counts, null != absent, "2015" != 2015, a timestamp equals only
 * the same timestamp text. Returns the path of the first difference, or null.
 */
export function firstDifference(a: unknown, b: unknown, path: string = "<root>"): string | null {
  if (a instanceof YamlTimestamp || b instanceof YamlTimestamp) {
    return a instanceof YamlTimestamp && b instanceof YamlTimestamp && a.text === b.text ? null : `${path}: timestamp differs`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: list vs non-list`;
    if (a.length !== b.length) return `${path}: list length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.join("\u0000") !== kb.join("\u0000")) return `${path}: keys [${ka}] vs [${kb}]`;
    for (const k of ka) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return Object.is(a, b) ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}
