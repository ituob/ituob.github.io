import { describe, expect, it } from "vitest";
import { parseYaml, stringifyYamlPreservingSource } from "./yaml-io";

const bridge = (value: unknown) => JSON.parse(JSON.stringify(value));
function edit(source: string, update: (value: any) => void): string {
  const value = bridge(parseYaml(source));
  update(value);
  const saved = stringifyYamlPreservingSource(value, source);
  expect(bridge(parseYaml(saved))).toEqual(value);
  return saved;
}

describe("YAML edits preserve surrounding source", () => {
  it.each([
    ["'Old'", "O'Brien", "'O''Brien'"],
    ['"Old"', 'quote " and slash \\', '"quote \\" and slash \\\\"'],
    ["Old", "yes", '"yes"'],
    ["Old", "part, two", "part, two"],
    ["Old", "first\nsecond", '"first\\nsecond"'],
  ])("escapes %s without changing neighboring quotes or trivia", (old, value, token) => {
    const source = `---\r\n# heading\r\nkeep: 'yes' # untouched\r\nvalue: ${old} # retain\r\n`;
    expect(edit(source, next => { next.value = value; })).toBe(source.replace(old, token));
  });

  it("quotes delimiters inside flow collections and retains their layout", () => {
    const source = "# header\nouter: {items: [Old, 'keep'], other: yes} # tail\n";
    expect(edit(source, value => { value.outer.items[0] = "one, two"; }))
      .toBe(source.replace("Old", '"one, two"'));
  });

  it("replaces a multiline scalar while keeping adjacent comments and CRLF", () => {
    const source = "keep: 'quoted'\r\nvalue: | # authored\r\n  old\r\n  text\r\nnext: yes\r\n";
    expect(edit(source, value => { value.value = "new\ntext\n"; }))
      .toBe(source.replace("old", "new"));
  });

  it("keeps aliases verbatim when an unrelated field changes", () => {
    const source = "original: &notice {en: 'Keep'}\ncopy: *notice # alias\nvalue: Old";
    expect(edit(source, value => { value.value = "New"; })).toBe(source.replace("Old", "New"));
  });

  it("detaches an alias when its anchored value changes independently", () => {
    const source = "original: &notice {en: 'Old'}\ncopy: *notice # alias\nkeep: 'quoted'\n";
    const saved = edit(source, value => { value.original.en = "New"; });
    expect(saved).toBe("original: &notice {en: 'New'}\ncopy: { en: Old } # alias\nkeep: 'quoted'\n");
  });

  it("retains an alias when both JSON copies receive the same edit", () => {
    const source = "original: &notice {en: 'Old'}\ncopy: *notice\n";
    expect(edit(source, value => { value.original.en = "New"; value.copy.en = "New"; }))
      .toBe(source.replace("Old", "New"));
  });

  it.each([
    (value: any) => { value.nested.added = "yes"; },
    (value: any) => { delete value.nested.first; },
    (value: any) => { value.nested = { second: 2, first: 1 }; },
    (value: any) => { value.nested = ["one", "two"]; },
  ])("supports structural edits inside the smallest changed subtree", update => {
    const source = "# keep\nquoted: 'untouched'\nnested:\n  first: 1\n  second: 2\ntail: yes\n";
    const saved = edit(source, update);
    expect(saved).toMatch(/^# keep\nquoted: 'untouched'\nnested:\n  /);
    expect(saved).toMatch(/\ntail: yes\n$/);
  });

  it("inserts an implicit null scalar without touching siblings", () => {
    const source = "value:\nkeep: 'quoted'\n";
    expect(edit(source, value => { value.value = "Text"; })).toBe("value: Text\nkeep: 'quoted'\n");
  });

  it("removes an explicit scalar tag when its value changes type", () => {
    const source = "value: !!str 'old' # retain\nkeep: 'quoted'\n";
    expect(edit(source, value => { value.value = 2; })).toBe("value: 2 # retain\nkeep: 'quoted'\n");
  });

  it("adds and removes optional top-level fields without rewriting siblings", () => {
    const source = "# heading\r\ntype: custom\r\ntitle: 'Keep quotes'\r\n";
    const added = edit(source, value => { value.contents = "New"; });
    expect(added).toBe(source + "contents: New\r\n");
    expect(edit(added, value => { delete value.contents; })).toBe(source);
    expect(edit(source, value => { value.contents = "New\n\n"; }))
      .toBe(source + 'contents: "New\\n\\n"\r\n');
  });

  it("preserves field insertion order and a missing final newline", () => {
    const source = "keep: 'quoted'";
    const saved = edit(source, value => { value.first = 1; value.second = 2; });
    expect(saved).toBe("keep: 'quoted'\nfirst: 1\nsecond: 2");
    expect(edit(saved, value => { delete value.second; })).toBe("keep: 'quoted'\nfirst: 1");
  });

  it("keeps comments attached to a removed optional field", () => {
    const source = "title: Optional # retain this comment\nkeep: 'quoted'\n";
    expect(edit(source, value => { delete value.title; }))
      .toBe("# retain this comment\nkeep: 'quoted'\n");
  });

  it("adds sequence items without rewriting an unrelated sibling", () => {
    const source = "items: [one, two]\nkeep: 'quoted'";
    const saved = edit(source, value => { value.items.push("three"); });
    expect(saved).toBe("items: [ one, two, three ]\nkeep: 'quoted'");
  });
});
