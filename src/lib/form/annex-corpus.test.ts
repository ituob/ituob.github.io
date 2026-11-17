import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from '../fs';
import { GET } from '../../pages/annexes.json';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function corpus() {
  const root = mkdtempSync(join(tmpdir(), 'annex-corpus-')); roots.push(root);
  vi.spyOn(fs, 'obIssuesRoot').mockReturnValue(root);
  return root;
}

describe('shipped annex authoring corpus', () => {
  it('fails closed when the source corpus is missing', () => {
    const root = corpus();
    vi.spyOn(fs, 'obIssuesRoot').mockReturnValue(join(root, 'missing'));
    expect(() => GET({} as any)).toThrow('Annex source corpus is unavailable');
  });
  it('serves complete fixture mappings and distinguishes issues without an annex file', async () => {
    const root = corpus();
    for (const issue of [1000, 1162, 1351]) mkdirSync(join(root, String(issue)));
    for (const issue of [1000, 1162]) writeFileSync(join(root, String(issue), 'annexes.yaml'), readFileSync(`test/fixtures/annexes/${issue}.yaml`));
    const response = await GET({} as any);
    const result = await response.json();
    expect(result.ok).toBe(true);
    for (const issue of [1000, 1162]) expect(result.annexes[issue]).toEqual(parse(readFileSync(`test/fixtures/annexes/${issue}.yaml`, 'utf8')));
    expect(result.annexes[1162].E212_MNC.position_on).toBe('2018-12-15T00:00:00.000Z');
    expect(result.annexes[1162].E212_MNC.datasets).toBeDefined();
    expect(result.annexes).not.toHaveProperty('1351');
  });
  it('fails instead of replacing unreadable source with an empty authoring mapping', () => {
    const root = corpus(); mkdirSync(join(root, '1162'));
    writeFileSync(join(root, '1162', 'annexes.yaml'), 'A: [unterminated');
    expect(() => GET({} as any)).toThrow();
  });
});
