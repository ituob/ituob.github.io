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
