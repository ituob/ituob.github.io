import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import * as renderer from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as accountApi from '../../components/account/api';

// Compile the actual island script and template using the form suite's Node setup.
function headerAccount() {
  const filename = 'src/components/account/HeaderAccount.vue';
  const { descriptor } = parse(readFileSync(filename, 'utf8'));
  const mounted: Array<() => Promise<void>> = [];
  const modules: Record<string, unknown> = {
    vue: { ...Vue, onMounted: (hook: () => Promise<void>) => mounted.push(hook) },
    'vue/server-renderer': renderer,
    './api': accountApi,
  };
  function evaluate(source: string) {
    const js = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    const result = { exports: {} as any };
    new Function('require', 'module', 'exports', js)((name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
      return modules[name];
    }, result, result.exports);
    return result.exports;
  }
  const component = evaluate(compileScript(descriptor, { id: 'header-account-test' }).content).default;
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'header-account-test', ssr: true });
  expect(template.errors).toEqual([]);
  const state = component.setup({}, { expose() {} });
  const ssrRender = evaluate(template.code).ssrRender;
  return {
    mount: async () => { for (const hook of mounted) await hook(); },
    html: () => renderer.renderToString(Vue.createSSRApp({ setup: () => ({ ...state }), ssrRender })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('header account control', () => {
  it('hydrates the account control alongside the existing primary navigation', () => {
    const layout = readFileSync('src/layouts/Base.astro', 'utf8');
    expect(layout).toContain('import HeaderAccount from "~/components/account/HeaderAccount.vue"');
    expect(layout).toMatch(/<nav class="sections" aria-label="Primary">[\s\S]*?<\/nav>\s*<HeaderAccount client:load \/>/);
  });

  it('loads the cookie identity on mount and offers sign in to signed-out visitors', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ authenticated: false }));
    vi.stubGlobal('fetch', fetcher);
    const view = headerAccount();
    expect(fetcher).not.toHaveBeenCalled();
    await view.mount();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/whoami', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
    }));
    const html = await view.html();
    expect(html).toContain('href="/auth/login?return_to=%2Fme%2F">Sign in</a>');
    expect(html).not.toContain('/auth/logout');
    expect(html).not.toContain('<details');
  });

  it.each([
    [{ displayName: 'Ada Example', email: 'ada@example.test' }, 'Ada Example'],
    [{ displayName: null, email: 'ada@example.test' }, 'ada@example.test'],
    [{ displayName: null, email: null }, 'subject-123'],
  ])('shows the account name and same-origin POST logout for %j', async (user, label) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ authenticated: true, userId: 'subject-123', user })));
    const view = headerAccount();
    await view.mount();
    const html = await view.html();
    expect(html).toContain(`<summary>${label}</summary>`);
    expect(html).toContain('aria-label="Account"');
    expect(html).toContain('href="/me/">My account</a>');
    expect(html).toContain('<form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>');
    expect(html).not.toContain('>Sign in</a>');
  });

  it('escapes identity text instead of rendering account data as markup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ authenticated: true, user: { displayName: '<img src=x onerror=alert(1)>' } })));
    const view = headerAccount();
    await view.mount();
    const html = await view.html();
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('keeps a usable sign-in link if identity loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const view = headerAccount();
    await view.mount();
    const html = await view.html();
    expect(html).toContain('>Sign in</a>');
    expect(html).not.toContain('/auth/logout');
  });
});
