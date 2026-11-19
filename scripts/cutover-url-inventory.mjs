#!/usr/bin/env node
// Enumerate the deployed Jekyll artifact and execute relevant Astro path generators.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[at + 1];
}
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const digest = (v) => createHash('sha256').update(v).digest('hex');
const walk = (dir) => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const legacyRef = option('--legacy-ref', 'origin/production-jekyll');
const legacySha = git(root, 'rev-parse', legacyRef);
const sourceSha = git(root, 'rev-parse', 'HEAD');
const out = resolve(option('--output', join(root, 'docs/migration/old-url-map.json')));
const dataRepo = resolve(option('--data-repo', join(root, 'data')));
const obRepo = resolve(option('--data-ob-repo', join(root, 'data-ob')));
const projectionRoot = option('--projection-root', process.env.OB_DATA_ROOT || null);
const testRoutes = args.includes('--test');
if (projectionRoot && !existsSync(join(resolve(projectionRoot), 'ob-issues'))) throw new Error('Projection root must contain ob-issues/');
const gitlink = (name) => git(root, 'rev-parse', `HEAD:${name}`);
const scratch = mkdtempSync(join(tmpdir(), 'ituob-url-map-'));
let server;
const initialCwd = process.cwd();
try {
  // Read committed data, never a possibly dirty checkout/projection.
  for (const [name, repo, paths] of [['data-ob', obRepo, projectionRoot ? ['catalogs'] : ['ob-issues', 'catalogs', 'datasets']], ['data', dataRepo, ['recommendations', 'lists']]]) {
    const dest = join(scratch, name);
    mkdirSync(dest, { recursive: true });
    const archive = execFileSync('git', ['archive', gitlink(name), ...paths], { cwd: repo, maxBuffer: 512 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', dest], { input: archive });
  }
  if (projectionRoot) for (const name of ['ob-issues', 'datasets']) {
    const source = join(resolve(initialCwd, projectionRoot), name);
    if (!existsSync(source)) throw new Error(`Projection is missing ${name}/`);
    symlinkSync(source, join(scratch, 'data-ob', name), 'dir');
  }
  // Register index generation only reads manifest existence, not replay contents.
  // These generated, untracked inputs have their own content hashes below.
  const snapshotInputs = [];
  const snapshotRoot = join(dataRepo, 'snapshots');
  if (existsSync(snapshotRoot)) for (const slug of readdirSync(snapshotRoot).sort()) {
    const file = join(snapshotRoot, slug, 'manifest.json');
    if (!existsSync(file)) continue;
    const raw = readFileSync(file);
    const dest = join(scratch, 'data/snapshots', slug);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'manifest.json'), raw);
    snapshotInputs.push({ path: `data/snapshots/${slug}/manifest.json`, sha256: digest(raw) });
  }
  const pageFiles = walk(join(root, 'src/pages')).sort();
  const generatedSources = new Map();
  const evaluatedSources = [];
  const routes = new Set();
  const canonical = (file) => {
    if (relative(join(root, 'src/pages'), file) === '404.astro') return '/404.html';
    let value = relative(join(root, 'src/pages'), file).replace(/\.(astro|ts)$/, '').replace(/(^|\/)index$/, '');
    return value === '' ? '/' : value.endsWith('.json') ? `/${value}` : `/${value}/`;
  };
  const selected = ['docs/[...slug].astro', 'issues/[id]/index.astro', 'issues/[id]/[lang].astro', 'recommendations/[code]/index.astro', 'registers/[slug]/index.astro', 'recommendations/[code]/years/[year]/index.astro', 'registers/[slug]/editions/[edition]/index.astro', 'registers/[slug]/editions/[edition]/years/[year]/index.astro'];
  for (const file of pageFiles) {
    if (!file.includes('[')) routes.add(canonical(file));
    if (!selected.includes(relative(join(root, 'src/pages'), file))) continue;
    const raw = readFileSync(file, 'utf8');
    const frontmatter = raw.split('---')[1];
    const ast = ts.createSourceFile(file, frontmatter, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports = ast.statements.filter(ts.isImportDeclaration).filter(s => !s.moduleSpecifier.text.endsWith('.astro') && !s.moduleSpecifier.text.endsWith('.vue'));
    const generator = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'getStaticPaths');
    if (!generator) throw new Error(`No getStaticPaths function in ${file}`);
    const id = `/@cutover/${evaluatedSources.length}.ts`;
    generatedSources.set(id, [...imports, generator].map(s => s.getText(ast)).join('\n').replace('../../content/legacy-help/', '/src/content/legacy-help/'));
    evaluatedSources.push({ source: relative(root, file), sha256: digest(raw), id });
  }
  process.chdir(scratch); // snapshots.ts deliberately resolves data against cwd.
  server = await createServer({ root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false },
    resolve: { alias: { '~': join(root, 'src') } },
    define: { 'import.meta.env.OB_DATA_ROOT': JSON.stringify(join(scratch, 'data-ob')), 'import.meta.env.ITU_OB_DATA_ROOT': JSON.stringify(join(scratch, 'data')) },
    plugins: [{ name: 'cutover-path-functions', resolveId(id) { if (generatedSources.has(id)) return id; }, load(id) { return generatedSources.get(id); } }],
  });
  for (const item of evaluatedSources) {
    console.error(`[cutover] Enumerating ${item.source}`);
    const mod = await server.ssrLoadModule(item.id);
    const paths = await mod.getStaticPaths();
    item.count = paths.length;
    const template = canonical(join(root, item.source));
    for (const { params } of paths) routes.add(template.replace(/\[([^\]]+)\]/g, (_, key) => {
      if (key.startsWith('...')) return params[key.slice(3)] ?? '';
      if (params[key] == null) throw new Error(`Missing ${key} for ${item.source}`);
      return params[key];
    }).replace(/\/+/g, '/'));
    delete item.id;
  }
  const { loadRegisterCatalog } = await server.ssrLoadModule(join(root, 'src/lib/loaders.ts'));
  const catalog = loadRegisterCatalog();
  const { legacyRedirectTarget } = await server.ssrLoadModule(join(root, 'worker/lib/legacy-redirects.ts'));
  const archiveRoutes = JSON.parse(readFileSync(join(root, 'src/lib/legacy-archive-routes.json'), 'utf8'));
  const failures = [];
  const files = git(root, 'ls-tree', '-r', '--name-only', legacySha).split('\n');
  const publicFiles = new Set(walk(join(root, 'public')).map(f => '/' + relative(join(root, 'public'), f)));
  const pages = files.filter(f => f.endsWith('.html')).map(file => {
    const oldPath = '/' + file.replace(/(^|\/)index\.html$/, '$1');
    let candidate = null, rationale = 'No equivalent page identified';
    if (routes.has(oldPath)) { candidate = oldPath; rationale = 'Identical generated route'; }
    else {
      const issue = file.match(/^issues\/(\d+)-([a-z]+)\/index\.html$/);
      const rec = file.match(/^messages\/complement-to-itu-t-r ([^/]+)(?:\/(\d{4}))?\/index\.html$/);
      const publication = file.match(/^messages\/amending-sp (.+) \(([^)]+)\)(?:\/(\d{4}))?\/index\.html$/);
      if (issue) { candidate = `/issues/${issue[1]}/${issue[2] === 'en' ? '' : issue[2] + '/'}`; rationale = 'Issue ID and explicit language from old filename'; }
      if (rec) { candidate = `/recommendations/${rec[1]}/`; rationale = rec[2] ? 'Recommendation overview exists; legacy year filtering has no equivalent route' : 'Recommendation code from old filename'; }
      if (publication) {
        const entries = catalog.filter(r => r.register_id === publication[1]);
        if (entries.length === 1) { candidate = `/registers/${entries[0].slug}/`; rationale = 'Catalog register_id match; legacy publication edition/year filtering has no equivalent route'; }
        else rationale = `No unique catalog register_id match for ${publication[1]}`;
      }
    }
    const redirect = legacyRedirectTarget(oldPath);
    if (redirect) {
      candidate = redirect;
      rationale = archiveRoutes[oldPath] ? 'Exact legacy edition/year membership retained by scoped archive' : 'Installed Worker compatibility redirect';
    }
    const targetExists = candidate !== null && routes.has(candidate);
    const semanticGap = /filtering has no equivalent/.test(rationale);
    return { old_url: oldPath, encoded_old_url: oldPath.split('/').map(encodeURIComponent).join('/'), old_file: file,
      new_route: targetExists ? candidate : null, candidate_route: candidate,
      status: !targetExists ? 'no_new_page' : candidate === oldPath ? 'same_path' : semanticGap ? 'replacement_requires_decision' : 'redirect_required',
      redirect_present: redirect !== null,
      archive_disposition: archiveRoutes[oldPath] ? (redirect === archiveRoutes[oldPath] && targetExists ? 'exact_scope' : 'overview') : null, publication_scope: file.startsWith('_app_help/') ? 'underscore_copy_not_established_public' : 'public_shaped_artifact_not_individually_http_probed',
      route_evidence: targetExists && candidate.startsWith('/registers/') && !catalog.find(r => `/registers/${r.slug}/` === candidate)?.external ? 'conditional_on_hashed_untracked_snapshot_manifest' : targetExists ? 'committed_source_and_gitlink_data' : 'no_verified_target',
      rationale };
  });
  // Exercise the same resolver used before ASSETS, against concrete path generators.
  // The published custom 404 has a route but intentionally returns HTTP 404.
  // Underscore help copies were never public and deliberately remain unmapped.
  for (const row of pages) {
    if (row.old_url.startsWith('/_app_help/')) {
      if (legacyRedirectTarget(row.old_url) || routes.has(row.old_url)) failures.push(`${row.old_url}: underscore copy unexpectedly mapped`);
      continue;
    }
    for (const alias of new Set([row.old_url, '/' + row.old_file, row.old_url.endsWith('/') && row.old_url !== '/' ? row.old_url.slice(0, -1) : row.old_url, row.encoded_old_url, row.encoded_old_url.replace(/\(/g, '%28').replace(/\)/g, '%29'), ('/' + row.old_file).split('/').map(encodeURIComponent).join('/')])) {
      const destination = legacyRedirectTarget(alias);
      if (destination ? !routes.has(destination) || legacyRedirectTarget(destination) : !routes.has(row.old_url)) {
        failures.push(`${alias}: no direct route or one-hop redirect to a generated route`);
      }
    }
  }
  const scopes = JSON.parse(readFileSync(join(root, 'src/lib/legacy-archive-scopes.json'), 'utf8'));
  for (const scope of scopes) {
    const row = pages.find(page => page.old_url === scope.old_url);
    if (!row) { failures.push(`${scope.old_url}: scope has no legacy source`); continue; }
    if (row.new_route !== scope.new_route) failures.push(`${scope.old_url}: exact scoped destination is not installed`);
    const html = git(root, 'show', `${legacySha}:${row.old_file}`);
    const ids = [...new Set([...html.matchAll(/<article\b[\s\S]*?<\/article>/g)].flatMap(article =>
      [...article[0].matchAll(/<a\b(?=[^>]*\btitle="Link to this message")[^>]*\bhref="\/issues\/(\d+)-en\/#[^"]*"/g)].map(match => Number(match[1]))
    ))].sort((a, b) => b - a);
    if (JSON.stringify(ids) !== JSON.stringify(scope.issueIds)) failures.push(`${scope.old_url}: archive membership differs from legacy articles`);
    for (const id of scope.issueIds) if (!routes.has(`/issues/${id}/`)) failures.push(`${scope.old_url}: missing source issue ${id}`);
  }
  const resources = files.filter(f => !f.endsWith('.html')).map(file => ({ old_url: '/' + file, status: publicFiles.has('/' + file) ? 'public_same_path' : 'not_in_public' }));
  const counts = (rows) => rows.reduce((sum, row) => { sum[row.status] = (sum[row.status] ?? 0) + 1; return sum; }, {});
  const report = {
    inputs: { source_sha: sourceSha, legacy_sha: legacySha, legacy_ref: legacyRef, data_sha: gitlink('data'), data_ob_sha: gitlink('data-ob'), snapshot_manifests: snapshotInputs,
      projection: projectionRoot ? { provenance: option('--projection-provenance', 'caller supplied'), file_count: walk(resolve(initialCwd, projectionRoot)).length, tree_sha256: digest(walk(resolve(initialCwd, projectionRoot)).sort().map(f => `${relative(resolve(initialCwd, projectionRoot), f)}\0${digest(readFileSync(f))}`).join('\n')) } : null,
      route_source_sha256: pageFiles.map(f => ({ path: relative(root, f), sha256: digest(readFileSync(f)) })) },
    methodology: 'All tracked production HTML files, including help/docs and collection/year archives. Execute imported getStaticPaths functions from current Astro source using Vite SSR with the recorded issue/dataset input and committed catalog/recommendation data, without rendering/building. Static pages/endpoints from src/pages; candidate dynamic routes checked against actual generated paths, never a wildcard match.',
    limitations: ['Routes are source-inferred from current source plus the recorded projection when supplied, otherwise normalized gitlink data. A prior CI projection is not the exact main release; rendering and deployment still need artifact verification.', 'Generated snapshot manifests are separately hashed untracked inputs; snapshot-dependent rows are conditional. No replay data or full build was run.', 'Only dynamic route families that can serve these old URLs are evaluated, including scoped legacy archives; other dynamic families are not counted.', 'Same path proves route existence, not content parity or HTTP deployment behavior. Worker redirect destinations are checked against the concrete route table.', 'Resource presence is path-only (not byte parity); tracked source data/cache resources are included conservatively. Sitemap output from the Astro integration requires a build; its sitemap index does not imply a legacy sitemap.xml alias.'],
    summary: { compatibility: { redirected: pages.filter(p => p.redirect_present).length, scoped_page: pages.filter(p => p.archive_disposition === 'exact_scope').length, overview: pages.filter(p => p.archive_disposition === 'overview').length, unmapped: pages.filter(p => !p.new_route).length, same_path: pages.filter(p => p.status === 'same_path').length, failures }, old_pages: pages.length, pages: counts(pages), relevant_new_routes: routes.size, old_resources: resources.length, resources: counts(resources), legacy_feed_sitemap_pagination_files: files.filter(f => /(^|\/)(feed|sitemap|atom|rss|page\d*)([/.]|$)/i.test(f)) },
    evaluated_generators: evaluatedSources, pages, resources,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary, null, 2));
  if (testRoutes && failures.length) throw new Error(`Legacy route coverage failed (${failures.length}):\n${failures.join('\n')}`);
} finally {
  await server?.close();
  process.chdir(initialCwd);
  rmSync(scratch, { recursive: true, force: true });
}
