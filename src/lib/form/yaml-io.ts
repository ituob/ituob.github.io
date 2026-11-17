/**
 * YAML read/write that keeps stored values exact.
 *
 * The corpus is written by Ruby (Psych, YAML 1.1 rules), so it is read the
 * same way: `yes` is a boolean, `1:30` an integer, an unquoted
 * `2012-01-31 23:00:00.000000000 Z` a timestamp. The `yaml` package's stock
 * 1.1 timestamp tag would turn timestamps into JS Dates and re-emit
 * `2012-03-15T00:00:00.000Z` as `2012-03-15` (Ruby: Time becomes Date), so
 * timestamps are held as `YamlTimestamp` and re-emitted with their stored
 * text. Everything else is plain JSON-shaped data; a string stays a string
 * ("2015", "yes" come back quoted), null stays null, `{en: ""}` stays so.
 */
import { parse, stringify, type DocumentOptions, type ParseOptions, type SchemaOptions, type ToStringOptions } from "yaml";

/** A YAML 1.1 timestamp (date or datetime) exactly as stored. */
export class YamlTimestamp {
  constructor(readonly text: string) {}
  toJSON(): string {
    return this.text;
  }
}

const TIMESTAMP_TAG = "tag:yaml.org,2002:timestamp";
const TIMESTAMP_RE =
  /^\d{4}-\d{1,2}-\d{1,2}(?:(?:[Tt]|[ \t]+)\d{1,2}:\d{2}:\d{2}(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d{1,2}(?::\d{2})?))?)?$/;

const timestampTag = {
  tag: TIMESTAMP_TAG,
  default: true,
  test: TIMESTAMP_RE,
  identify: (v: unknown) => v instanceof YamlTimestamp,
  resolve: (text: string) => new YamlTimestamp(text),
  stringify: ({ value }: { value: unknown }) => (value as YamlTimestamp).text,
};

const OPTIONS: DocumentOptions & ParseOptions & SchemaOptions & ToStringOptions = {
  version: "1.1",
  // The corpus carries ProseMirror documents and aliases; resolving aliases
  // into plain values is what the Ruby loader does (aliases: true).
  customTags: (tags) => (tags as { tag?: string }[]).filter((t) => t.tag !== TIMESTAMP_TAG).concat([timestampTag as never]) as never,
  lineWidth: 0,
};

export function parseYaml(text: string): unknown {
  return parse(text, OPTIONS);
}

export function stringifyYaml(value: unknown): string {
  return stringify(value, OPTIONS);
}

/**
 * Reuse the original bytes when a loaded value has not changed. Timestamp text
 * and non-finite numbers also compare equal after the HTTP/D1 JSON bridge
 * (YamlTimestamp.toJSON and JSON null, respectively).
 * Edits use the normal YAML writer; reverting an edit restores the source bytes.
 * A transported null or timestamp string cannot express replacing the original
 * scalar with that identical JSON value; matching values retain the source type.
 */
export function stringifyYamlPreservingSource(value: unknown, sourceYaml?: string | null): string {
  if (sourceYaml == null) return stringifyYaml(value);
  const stored = parseYaml(sourceYaml);
  return sameSourceValue(stored, value) ? sourceYaml : stringifyYaml(restoreSourceValues(stored, value));
}

/** Keep scalar types lost in JSON when an unrelated field is edited. */
function restoreSourceValues(stored: unknown, current: unknown): unknown {
  if (sameSourceValue(stored, current)) return stored;
  if (Array.isArray(stored) && Array.isArray(current)) {
    return current.map((value, index) => restoreSourceValues(stored[index], value));
  }
  if (stored !== null && current !== null && typeof stored === "object" && typeof current === "object" &&
      !Array.isArray(stored) && !Array.isArray(current) &&
      !(stored instanceof YamlTimestamp) && !(current instanceof YamlTimestamp)) {
    return Object.fromEntries(Object.entries(current).map(([key, value]) => [key,
      Object.hasOwn(stored, key) ? restoreSourceValues((stored as Record<string, unknown>)[key], value) : value,
    ]));
  }
  return current;
}

function sameSourceValue(stored: unknown, current: unknown): boolean {
  if (stored instanceof YamlTimestamp) {
    return stored.text === (current instanceof YamlTimestamp ? current.text : current);
  }
  if (current instanceof YamlTimestamp) return false;
  if (Array.isArray(stored) || Array.isArray(current)) {
    return Array.isArray(stored) && Array.isArray(current) && stored.length === current.length &&
      stored.every((value, index) => sameSourceValue(value, current[index]));
  }
  if (stored !== null && current !== null && typeof stored === "object" && typeof current === "object") {
    const keys = Object.keys(stored);
    const currentKeys = Object.keys(current);
    return keys.length === currentKeys.length && keys.every((key, index) => key === currentKeys[index] &&
      sameSourceValue((stored as Record<string, unknown>)[key], (current as Record<string, unknown>)[key]));
  }
  if (typeof stored === "number" && typeof current === "number") {
    return stored === current || (Number.isNaN(stored) && Number.isNaN(current));
  }
  if (typeof stored === "number" && !Number.isFinite(stored) && current === null) return true;
  return Object.is(stored, current);
}
