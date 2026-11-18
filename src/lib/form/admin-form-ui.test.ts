import { readdirSync, readFileSync } from 'node:fs';
import { baseParse, type ElementNode, type RootNode, type TemplateChildNode } from '@vue/compiler-dom';
import { compileTemplate, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';

const directory = 'src/components/admin';
const components = readdirSync(directory).filter(file => file.endsWith('.vue')).sort();
const primitives: Record<string, string> = {
  fieldset: 'admin-fieldset', label: 'admin-label', input: 'admin-control',
  select: 'admin-control', textarea: 'admin-control', button: 'admin-button',
  table: 'admin-table', small: 'admin-help',
};

function elements(node: RootNode | TemplateChildNode): ElementNode[] {
  if (node.type === 0) return node.children.flatMap(elements);
  if (node.type !== 1) return [];
  return [node, ...node.children.flatMap(elements)];
}

function attribute(node: ElementNode, name: string): string | undefined {
  const prop = node.props.find(prop => prop.type === 6 && prop.name === name);
  return prop?.type === 6 ? prop.value?.content : undefined;
}

describe('shared admin form presentation', () => {
  it.each(components)('%s uses the shared stylesheet and primitives on its native controls', file => {
    const filename = `${directory}/${file}`;
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'));
    expect(errors).toEqual([]);
    expect(descriptor.scriptSetup?.content).toMatch(/import ['"]\.\.\/\.\.\/styles\/admin-forms\.css['"]/);
    expect(descriptor.styles.some(style => style.src === '../../styles/admin-forms.css')).toBe(false);
    const source = descriptor.template!.content;
    expect(compileTemplate({ source, filename, id: 'admin-form-ui' }).errors).toEqual([]);
    const nodes = elements(baseParse(source));
    expect(nodes.some(node => attribute(node, 'class')?.split(/\s+/).includes('admin-form'))).toBe(true);
    for (const node of nodes) {
      const primitive = attribute(node, 'role') === 'alert' ? 'admin-error'
        : attribute(node, 'role') === 'status' ? 'admin-status' : primitives[node.tag];
      if (primitive) expect(attribute(node, 'class')?.split(/\s+/), `${file}: <${node.tag}> needs ${primitive}`).toContain(primitive);
    }
  });
});
