import type { APIRoute } from 'astro';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { listDirs, obIssuesRoot } from '../lib/fs';
import type { AnnexesWire } from '../lib/form/annexes';

/** Complete annex mappings from the shipped data pin, including opaque datasets. */
export const GET: APIRoute = () => {
  const root = obIssuesRoot();
  if (!existsSync(root)) throw new Error('Annex source corpus is unavailable');
  const annexes: Record<string, AnnexesWire> = {};
  for (const issue of listDirs(root).filter(id => /^[1-9]\d*$/.test(id))) {
    const path = join(root, issue, 'annexes.yaml');
    if (!existsSync(path)) continue;
    // Keep YAML 1.2 date/time scalars as strings. Fail the build on malformed
    // source rather than ship an empty editable replacement for existing data.
    annexes[issue] = parse(readFileSync(path, 'utf8')) ?? {};
  }
  return new Response(JSON.stringify({ ok: true, annexes }), { headers: { 'content-type': 'application/json' } });
};
