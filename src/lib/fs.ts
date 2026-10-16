/**
 * Filesystem loaders for OB issue and dataset data.
 *
 * Reads directly from the data submodules: data-ob (service-publications-docs)
 * and data (itu-ob-data), pointed to by import.meta.env.OB_DATA_ROOT /
 * ITU_OB_DATA_ROOT (set in astro.config.mjs).
 *
 * All loaders are pure (no side effects) and cached per build.
 *
 * Robustness policy: parse failures are logged to stderr but do NOT abort
 * the build — the data is large and a single malformed YAML file should not
 * take the whole site down. Callers receive `null` on failure and degrade
 * gracefully.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_ROOT: string =
  (import.meta as any).env?.OB_DATA_ROOT ?? join(__dirname, "../../data-ob");

const ITU_OB_DATA_ROOT: string =
  (import.meta as any).env?.ITU_OB_DATA_ROOT ?? join(DATA_ROOT, "..", "data");

export function dataRoot(): string {
  return DATA_ROOT;
}

export function obIssuesRoot(): string {
  return join(DATA_ROOT, "ob-issues");
}

export function datasetsRoot(): string {
  return join(DATA_ROOT, "datasets");
}

export function catalogsRoot(): string {
  return join(DATA_ROOT, "catalogs");
}

export function recommendationsRoot(): string {
  return join(ITU_OB_DATA_ROOT, "recommendations");
}

export function listsRoot(): string {
  return join(ITU_OB_DATA_ROOT, "lists");
}

/** Parse a YAML string into an unknown. Logs parse errors to stderr. */
export function parseYamlSafe<T>(raw: string, source = "<inline>"): T | null {
  try {
    return parseYaml(raw) as T;
  } catch (err) {
    process.stderr.write(
      `[ob] YAML parse error in ${source}: ${(err as Error).message.split("\n")[0]}\n`,
    );
    return null;
  }
}

/** Parse a YAML file (UTF-8) into a value, or null on parse error. */
export function readYaml<T = unknown>(path: string): T | null {
  const raw = readFileSync(path, "utf-8");
  return parseYamlSafe<T>(raw, path);
}

/** Read a YAML file if it exists; otherwise return null. */
export function readYamlOrNull<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  return readYaml<T>(path);
}

/** Memoization helper — caches by argument signature. */
export function memoize<Args extends unknown[], Out>(
  fn: (...args: Args) => Out,
): (...args: Args) => Out {
  const cache = new Map<string, Out>();
  return (...args: Args): Out => {
    const key = JSON.stringify(args);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const out = fn(...args);
    cache.set(key, out);
    return out;
  };
}

/** List immediate subdirectory names under a path (non-recursive). */
export function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((name) => {
    const st = statSync(join(path, name));
    return st.isDirectory();
  });
}

/** List immediate file names under a path (non-recursive). */
export function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((name) => {
    const st = statSync(join(path, name));
    return st.isFile();
  });
}

export { dirname, basename, join };
