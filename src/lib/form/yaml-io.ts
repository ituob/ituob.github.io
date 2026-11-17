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
import { isAlias, isMap, isScalar, isSeq, parse, parseDocument, stringify, type DocumentOptions, type Node, type ParseOptions, type SchemaOptions, type ToStringOptions } from "yaml";

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
 * Edits patch the smallest changed node ranges; untouched YAML stays verbatim.
 * A transported null or timestamp string cannot express replacing the original
 * scalar with that identical JSON value; matching values retain the source type.
 */
export function stringifyYamlPreservingSource(value: unknown, sourceYaml?: string | null): string {
  if (sourceYaml == null) return stringifyYaml(value);
  const document = parseDocument(sourceYaml, OPTIONS);
  if (document.errors.length) throw document.errors[0];
  const stored = document.toJS();
  if (sameSourceValue(stored, value)) return sourceYaml;
  const current = restoreSourceValues(stored, value);
  const patches: { start: number; end: number; text: string }[] = [];
  const nodeValues = new Map<Node, unknown>();
  const record = (node: Node | null | undefined, next: unknown): void => {
    if (!node) return;
    nodeValues.set(node, next);
    if (isMap(node)) {
      for (const pair of node.items) {
        if (isScalar(pair.key)) record(pair.value as Node | null, isRecord(next) ? next[String(pair.key.value)] : undefined);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => record(item as Node | null, Array.isArray(next) ? next[index] : undefined));
    }
  };
  record(document.contents, current);

  const replace = (node: Node, next: unknown, inFlow: boolean): void => {
    if (!node.range) return;
    const original = sourceYaml.slice(node.range[0], node.range[1]);
    if (isScalar(node) && typeof node.value === "string" && typeof next === "string") {
      const local = editScalarSource(original, node.value, next, inFlow);
      if (local !== null) {
        patches.push({ start: node.range[0], end: node.range[1], text: local });
        return;
      }
    }
    if (node.tag) {
      const lineStart = sourceYaml.lastIndexOf("\n", node.range[0] - 1) + 1;
      const prefix = sourceYaml.slice(lineStart, node.range[0]);
      const tag = /!(?:<[^>]+>|[^\s]+)[ \t]+(?=(?:&[^\s]+[ \t]+)?$)/.exec(prefix);
      if (tag) patches.push({ start: lineStart + tag.index, end: lineStart + tag.index + tag[0].length, text: "" });
    }
    const replacement = document.createNode(next);
    // Flow collections are valid at any existing node indentation, including
    // inside another flow collection. Multiline strings use escaped newlines.
    if (isScalar(replacement) && typeof next === "string") {
      replacement.type = next.includes("\n") || next.includes("\r") ? "QUOTE_DOUBLE"
        : isScalar(node) && (node.type === "QUOTE_SINGLE" || node.type === "QUOTE_DOUBLE") ? node.type : "PLAIN";
    }
    let text: string;
    if (next === undefined) {
      text = "";
    } else if (isScalar(replacement) && inFlow) {
      const wrapper = document.createNode<unknown[]>([next]);
      wrapper.items[0] = replacement;
      text = stringify(wrapper, { ...OPTIONS, collectionStyle: "flow" }).trimEnd().slice(2, -2);
    } else {
      text = stringify(replacement, { ...OPTIONS, collectionStyle: isScalar(replacement) ? undefined : "flow" }).replace(/\n$/, "");
    }
    // Block scalars and block collections own their terminating newline. Keep
    // that separator, and the file's original final-newline convention.
    if (isScalar(node) && (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED")) {
      const headerComment = original.split(/\r?\n/, 1)[0].match(/[ \t]+#.*$/)?.[0];
      if (headerComment) text += headerComment;
    }
    if (original.endsWith("\n")) text += original.endsWith("\r\n") ? "\r\n" : "\n";
    if (node.range[0] === node.range[1] && /[:?-]/.test(sourceYaml[node.range[0] - 1] ?? "")) text = " " + text;
    patches.push({ start: node.range[0], end: node.range[1], text });
  };
  const patch = (node: Node | null | undefined, before: unknown, next: unknown, inFlow = false): void => {
    if (!node) return;
    if (isAlias(node)) {
      const target = node.resolve(document);
      // Updating an anchor must not silently change an independently edited
      // JSON copy of its alias. Expand only aliases that can no longer refer
      // to the anchor's requested value.
      if (!target || !sameSourceValue(nodeValues.get(target), next)) replace(node, next, inFlow);
      return;
    }
    if (isMap(node) && isRecord(before) && isRecord(next)) {
      const keys = Object.keys(before);
      const nextKeys = Object.keys(next);
      const pairs = node.items;
      const simpleKeys = pairs.every(pair => isScalar(pair.key) && Object.hasOwn(before, String(pair.key.value)));
      const retained = keys.filter(key => Object.hasOwn(next, key));
      if (!node.flow && simpleKeys && node.range &&
          retained.join("\0") === nextKeys.filter(key => Object.hasOwn(before, key)).join("\0") &&
          nextKeys.length > 0 && (keys.length !== nextKeys.length || keys.some(key => !Object.hasOwn(next, key)))) {
        const eol = sourceYaml.includes("\r\n") ? "\r\n" : "\n";
        const firstKey = pairs[0]?.key as Node | undefined;
        const indent = firstKey?.range ? firstKey.range[0] - sourceYaml.lastIndexOf("\n", firstKey.range[0] - 1) - 1 : 0;
        const lineStart = (offset: number) => sourceYaml.lastIndexOf("\n", offset - 1) + 1;
        for (const pair of pairs) {
          const key = String((pair.key as { value: unknown }).value);
          if (Object.hasOwn(next, key)) patch(pair.value as Node | null, before[key], next[key], inFlow);
          else {
            const keyNode = pair.key as Node;
            const valueNode = pair.value as Node | null;
            if (keyNode.range) {
              let start = lineStart(keyNode.range[0]);
              const end = valueNode?.range?.[2] ?? keyNode.range[2];
              const trailing = valueNode?.range ? sourceYaml.slice(valueNode.range[1], end) : "";
              const comment = trailing.match(/#[^\r\n]*/)?.[0];
              const text = comment ? " ".repeat(indent) + comment + (trailing.endsWith("\n") ? eol : "") : "";
              if (!text && end === sourceYaml.length && !sourceYaml.endsWith("\n") && start > 0) {
                start -= sourceYaml.slice(0, start).endsWith("\r\n") ? 2 : 1;
              }
              patches.push({ start, end, text });
            }
          }
        }
        for (let index = nextKeys.length - 1; index >= 0; index--) {
          const key = nextKeys[index]!;
          if (Object.hasOwn(before, key)) continue;
          const following = nextKeys.slice(index + 1).find(key => Object.hasOwn(before, key));
          const followingPair = pairs.find(pair => isScalar(pair.key) && String(pair.key.value) === following);
          const position = followingPair && (followingPair.key as Node).range
            ? lineStart((followingPair.key as Node).range![0]) : node.range[1];
          const entry = document.createNode({ [key]: next[key] });
          let text = " ".repeat(indent) + stringify(entry, { ...OPTIONS, collectionStyle: "flow" }).trimEnd().slice(2, -2);
          const atEndWithoutNewline = position === sourceYaml.length && !sourceYaml.endsWith("\n");
          text = (atEndWithoutNewline ? eol : "") + text + (atEndWithoutNewline ? "" : eol);
          patches.push({ start: position, end: position, text });
        }
        return;
      }
      if (keys.length === nextKeys.length && keys.every((key, index) => key === nextKeys[index]) &&
          node.items.every(pair => isScalar(pair.key) && Object.hasOwn(before, String(pair.key.value)))) {
        for (const pair of node.items) {
          const key = String((pair.key as { value: unknown }).value);
          patch(pair.value as Node | null, before[key], next[key], inFlow || !!node.flow);
        }
        return;
      }
    } else if (isSeq(node) && Array.isArray(before) && Array.isArray(next) && before.length === next.length) {
      node.items.forEach((item, index) => patch(item as Node | null, before[index], next[index], inFlow || !!node.flow));
      return;
    }
    if (!sameSourceValue(before, next)) replace(node, next, inFlow);
  };
  patch(document.contents, stored, current);
  let result = sourceYaml;
  for (const { start, end, text } of patches.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + text + result.slice(end);
  }
  // Validate the assembled ranges, including tags and alias interactions.
  // Unsupported source syntax must not silently rewrite unrelated bytes.
  try {
    if (sameSourceValue(parseYaml(result), current)) return result;
  } catch { /* Report unsupported syntax instead of losing source formatting. */ }
  throw new Error("Cannot preserve YAML source for this edit");
}

/** Try a byte-local substitution before re-encoding quotes or folded lines. */
function editScalarSource(source: string, before: string, next: string, inFlow: boolean): string | null {
  let prefix = 0;
  while (prefix < before.length && prefix < next.length && before[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < next.length - prefix &&
         before[before.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  const removed = before.slice(prefix, before.length - suffix);
  const inserted = next.slice(prefix, next.length - suffix);
  // An unambiguous literal occurrence can be changed without interpreting YAML
  // escapes. Validate the candidate so syntax-sensitive values get re-encoded.
  if (!removed) return null;
  const offset = source.indexOf(removed);
  if (offset < 0 || source.indexOf(removed, offset + 1) >= 0) return null;
  const candidate = source.slice(0, offset) + inserted + source.slice(offset + removed.length);
  try {
    if (sameSourceValue(inFlow ? (parseYaml(`[${candidate}]`) as unknown[])[0] : parseYaml(candidate), next)) return candidate;
  } catch { /* The normal scalar writer supplies any required escaping. */ }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof YamlTimestamp);
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
    return Object.fromEntries(Object.entries(current).filter(([, value]) => value !== undefined).map(([key, value]) => [key,
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
