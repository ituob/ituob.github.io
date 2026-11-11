/**
 * Form model: class description + stored instance -> editable form state ->
 * serialized instance.
 *
 * The contract is EXACTNESS. `toInstance(toFormState(d, cls, v))` equals `v`
 * for any stored instance `v`, including values the ontology types
 * differently from how they are stored (a mismatch becomes a `Diagnostic`,
 * never a coercion): null stays null (explicit nil != absent), "2015" stays
 * a string, a timestamp stays that timestamp, `{en: ""}` stays so, a map
 * stored where the ontology says list stays a map, unknown keys are carried
 * as extras and written back in their stored position.
 *
 * Nodes are plain data and every edit returns a new tree, so a renderer can
 * hold the state in any reactive store.
 */
import { YamlTimestamp } from "./yaml-io.ts";
import { description as defaultDescription, type AttributeDescription, type Description } from "./description.ts";

export type Path = readonly (string | number)[];

export interface Diagnostic {
  path: string;
  code: "shape" | "type" | "enum" | "unknown-key" | "unknown-class" | "required";
  message: string;
}

/** A value shown by one input (scalar, enum choice, or opaque Hash/HashOrText content). */
export interface LeafNode {
  kind: "leaf";
  /** Declared ontology type, or "any" for an extra key. */
  type: string;
  value: unknown;
}

export interface ListNode {
  kind: "list";
  itemType: string;
  itemKind: AttributeDescription["kind"];
  items: FormNode[];
}

export interface FormField {
  attr: AttributeDescription;
  /** null = absent from the instance (the form shows an empty input). */
  node: FormNode | null;
}

export interface ObjectNode {
  kind: "object";
  className: string;
  /** One entry per declared attribute, in ontology order. */
  fields: FormField[];
  /** Keys present in the instance, in stored order (wire names, declared or extra). */
  keyOrder: string[];
  /** Keys the class does not declare, kept verbatim. */
  extras: Record<string, unknown>;
}

export type FormNode = LeafNode | ListNode | ObjectNode;

export interface Built<T> {
  state: T;
  diagnostics: Diagnostic[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof YamlTimestamp);

const fmt = (path: Path) => path.join(".") || "<root>";

class Builder {
  readonly diagnostics: Diagnostic[] = [];
  constructor(readonly d: Description) {}

  private diag(path: Path, code: Diagnostic["code"], message: string) {
    this.diagnostics.push({ path: fmt(path), code, message });
  }

  object(className: string, value: Record<string, unknown>, path: Path): ObjectNode {
    const klass = this.d.classes[className];
    if (!klass) throw new Error(`unknown class ${className}`);
    const byWire = new Map(klass.attributes.map((a) => [a.wire, a]));
    const nodes = new Map<string, FormNode>();
    const extras: Record<string, unknown> = {};
    const keyOrder: string[] = [];
    for (const [key, v] of Object.entries(value)) {
      keyOrder.push(key);
      const attr = byWire.get(key);
      if (attr) nodes.set(key, this.attribute(attr, v, [...path, key]));
      else {
        extras[key] = v;
        this.diag([...path, key], "unknown-key", `${className} declares no attribute "${key}"`);
      }
    }
    const fields = klass.attributes.map((attr) => ({ attr, node: nodes.get(attr.wire) ?? null }));
    return { kind: "object", className, fields, keyOrder, extras };
  }

  attribute(attr: AttributeDescription, value: unknown, path: Path): FormNode {
    if (attr.collection) {
      if (Array.isArray(value)) {
        return {
          kind: "list",
          itemType: attr.type,
          itemKind: attr.kind,
          items: value.map((item, i) => this.single(attr, item, [...path, i])),
        };
      }
      if (value !== null) this.diag(path, "shape", `${attr.type} list stored as ${describe(value)}; kept as stored`);
      return { kind: "leaf", type: attr.type, value };
    }
    if (Array.isArray(value)) {
      this.diag(path, "shape", `${attr.type} stored as a list; kept as stored`);
      return { kind: "leaf", type: attr.type, value };
    }
    return this.single(attr, value, path);
  }

  private single(attr: AttributeDescription, value: unknown, path: Path): FormNode {
    const leaf = (): FormNode => ({ kind: "leaf", type: attr.type, value });
    if (value === null) return leaf();
    if (attr.kind === "class") {
      if (!isPlainObject(value)) {
        this.diag(path, "shape", `${attr.type} stored as ${describe(value)}; kept as stored`);
        return leaf();
      }
      return this.object(this.resolveClass(attr.type, value, path), value, path);
    }
    if (attr.kind === "enum") {
      if (typeof value !== "string" || !this.d.enums[attr.type]?.includes(value)) {
        this.diag(path, "enum", `${JSON.stringify(value)} is not in ${attr.type}`);
      }
      return leaf();
    }
    // primitive
    if (attr.type === "Hash" || attr.type === "HashOrText") {
      if (isPlainObject(value)) {
        const named = value["_class"];
        // A Hash that names a known class is an instance of it (e.g. RegisterChange.data).
        if (typeof named === "string" && this.d.classes[named]) return this.object(named, value, path);
        return leaf();
      }
      if (!(attr.type === "HashOrText" && typeof value === "string")) {
        this.diag(path, "type", `${attr.type} stored as ${describe(value)}`);
      }
      return leaf();
    }
    if (!fitsPrimitive(attr.type, value)) {
      this.diag(path, "type", `${attr.type} stored as ${describe(value)}`);
    }
    return leaf();
  }

  /** Subclass instances name themselves with `_class`; fall back to the declared class. */
  private resolveClass(declared: string, value: Record<string, unknown>, path: Path): string {
    const named = value["_class"];
    if (typeof named !== "string") return declared;
    if (this.d.classes[named]) return named;
    this.diag([...path, "_class"], "unknown-class", `_class ${JSON.stringify(named)} is not in the ontology; using ${declared}`);
    return declared;
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  if (v instanceof YamlTimestamp) return "a timestamp";
  return typeof v === "object" ? "a mapping" : `${typeof v} ${JSON.stringify(v)}`;
}

function fitsPrimitive(type: string, v: unknown): boolean {
  switch (type) {
    case "String":
      return typeof v === "string";
    case "Integer":
      return typeof v === "number" && Number.isInteger(v);
    case "Float":
      return typeof v === "number";
    case "Boolean":
      return typeof v === "boolean";
    case "Date":
    case "Time":
      return v instanceof YamlTimestamp;
    case "DateOrText":
      return v instanceof YamlTimestamp || typeof v === "string";
    default:
      return false;
  }
}

/** Stored instance of `className` -> form state (plus what the ontology and the data disagree on). */
export function toFormState(className: string, instance: unknown, d: Description = defaultDescription): Built<ObjectNode> {
  if (!isPlainObject(instance)) throw new Error(`${className} instance must be a mapping, got ${describe(instance)}`);
  const b = new Builder(d);
  const named = instance["_class"];
  const cls = typeof named === "string" && d.classes[named] ? named : className;
  const state = b.object(cls, instance, []);
  return { state, diagnostics: b.diagnostics };
}

/** Form state -> instance, keys in their stored order (new keys appended in ontology order). */
export function toInstance(node: FormNode): unknown {
  switch (node.kind) {
    case "leaf":
      return node.value;
    case "list":
      return node.items.map(toInstance);
    case "object": {
      const byWire = new Map(node.fields.map((f) => [f.attr.wire, f.node]));
      const out: Record<string, unknown> = {};
      for (const key of node.keyOrder) {
        const field = byWire.get(key);
        out[key] = field ? toInstance(field) : node.extras[key];
      }
      return out;
    }
  }
}

/** Required attributes (cardinality min >= 1) that are absent, recursively. */
export function validate(node: FormNode, path: Path = []): Diagnostic[] {
  if (node.kind === "leaf") return [];
  if (node.kind === "list") return node.items.flatMap((n, i) => validate(n, [...path, i]));
  return node.fields.flatMap((f) => {
    const at = [...path, f.attr.wire];
    if (f.node === null) {
      return f.attr.required
        ? [{ path: fmt(at), code: "required" as const, message: `${node.className}.${f.attr.name} is required` }]
        : [];
    }
    return validate(f.node, at);
  });
}

/** Every class instantiated anywhere in the tree (for coverage). */
export function classesIn(node: FormNode, into: Set<string> = new Set()): Set<string> {
  if (node.kind === "object") {
    into.add(node.className);
    for (const f of node.fields) if (f.node) classesIn(f.node, into);
  } else if (node.kind === "list") node.items.forEach((n) => classesIn(n, into));
  return into;
}

// ---- Renderer hints --------------------------------------------------------

export type Widget = "text" | "integer" | "number" | "boolean" | "date" | "select" | "json" | "object" | "list";

/** The input a renderer shows for an attribute; derived from the description only. */
export function widgetFor(attr: AttributeDescription): Widget {
  if (attr.collection) return "list";
  if (attr.kind === "class") return "object";
  if (attr.kind === "enum") return "select";
  switch (attr.type) {
    case "Integer":
      return "integer";
    case "Float":
      return "number";
    case "Boolean":
      return "boolean";
    case "Date":
    case "Time":
    case "DateOrText":
      return "date";
    case "Hash":
    case "HashOrText":
      return "json";
    default:
      return "text";
  }
}

// ---- Edits (each returns a new tree) -----------------------------------------

/** New empty instance: every attribute absent except declared defaults (`_class`). */
export function blankState(className: string, d: Description = defaultDescription): ObjectNode {
  const klass = d.classes[className];
  if (!klass) throw new Error(`unknown class ${className}`);
  const seed: Record<string, unknown> = {};
  for (const a of klass.attributes) if (a.default !== undefined && !a.collection) seed[a.wire] = a.default;
  return new Builder(d).object(className, seed, []);
}

/** Set one attribute from a raw instance value (built by the same rules as a load). */
export function setField(n: ObjectNode, name: string, value: unknown, d: Description = defaultDescription): ObjectNode {
  const idx = n.fields.findIndex((f) => f.attr.name === name);
  const field = n.fields[idx];
  if (!field) throw new Error(`${n.className} has no attribute ${name}`);
  const built = new Builder(d).attribute(field.attr, value, [name]);
  const fields = n.fields.map((f, i) => (i === idx ? { ...f, node: built } : f));
  return { ...n, fields, keyOrder: n.keyOrder.includes(field.attr.wire) ? n.keyOrder : orderedAppend(n, field.attr.wire) };
}

/** Remove one attribute (absent, not null). */
export function clearField(node: ObjectNode, name: string): ObjectNode {
  const field = node.fields.find((f) => f.attr.name === name);
  if (!field) throw new Error(`${node.className} has no attribute ${name}`);
  return {
    ...node,
    fields: node.fields.map((f) => (f === field ? { ...f, node: null } : f)),
    keyOrder: node.keyOrder.filter((k) => k !== field.attr.wire),
  };
}

/** A new key goes in ontology position relative to the keys already present, else last. */
function orderedAppend(node: ObjectNode, wire: string): string[] {
  const rank = new Map(node.fields.map((f, i) => [f.attr.wire, i]));
  const mine = rank.get(wire) ?? Infinity;
  const at = node.keyOrder.findIndex((k) => (rank.get(k) ?? -1) > mine);
  return at === -1 ? [...node.keyOrder, wire] : [...node.keyOrder.slice(0, at), wire, ...node.keyOrder.slice(at)];
}

export function appendItem(list: ListNode, value: unknown, d: Description = defaultDescription): ListNode {
  const attr: AttributeDescription = { name: "item", wire: "item", type: list.itemType, kind: list.itemKind, required: false, collection: false };
  return { ...list, items: [...list.items, new Builder(d).attribute(attr, value, [list.items.length])] };
}

export function removeItem(list: ListNode, index: number): ListNode {
  return { ...list, items: list.items.filter((_, i) => i !== index) };
}

/** Replace the node at `path` (field wire names and list indexes) with `f(node)`. */
export function updateAt(root: FormNode, path: Path, f: (n: FormNode) => FormNode): FormNode {
  const [head, ...rest] = path;
  if (head === undefined) return f(root);
  if (root.kind === "list" && typeof head === "number") {
    return { ...root, items: root.items.map((n, i) => (i === head ? updateAt(n, rest, f) : n)) };
  }
  if (root.kind === "object" && typeof head === "string") {
    const field = root.fields.find((x) => x.attr.wire === head);
    if (!field || field.node === null) throw new Error(`no ${head} in ${root.className}`);
    const child = updateAt(field.node, rest, f);
    return { ...root, fields: root.fields.map((x) => (x === field ? { ...x, node: child } : x)) };
  }
  throw new Error(`bad path segment ${String(head)}`);
}
