// Validate the opt-in binding examples and keep live deploys unprovisioned.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const liveFiles = ["wrangler.jsonc", "wrangler.staging.jsonc"];
const exampleFiles = ["wrangler.bindings.example.jsonc", "wrangler.staging.bindings.example.jsonc"];

export function parseJsonc(file, text) {
  const { config, error } = ts.parseConfigFileTextToJson(file, text);
  if (error) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${file}: expected a configuration object`);
  return config;
}

export function deriveBindings(directory) {
  const configPath = join(directory, "worker/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, " "));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const entry = join(directory, "worker/index.ts");
  const program = ts.createProgram([...parsed.fileNames, entry], parsed.options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const defaultExport = source && checker.getExportsOfModule(checker.getSymbolAtLocation(source)).find((s) => s.name === "default");
  if (!defaultExport) throw new Error("worker/index.ts: no default Worker export found");
  const worker = checker.getTypeOfSymbolAtLocation(defaultExport, source);
  const handler = (name) => {
    const symbol = worker.getProperty(name);
    return symbol && checker.getTypeOfSymbolAtLocation(symbol, source).getCallSignatures()[0];
  };
  const fetch = handler("fetch");
  const envParameter = fetch?.getParameters()[1];
  if (!envParameter) throw new Error("worker/index.ts: default fetch handler must declare its Env parameter");
  const env = checker.getTypeOfSymbolAtLocation(envParameter, source);
  const isBinding = (type, name) => {
    type = checker.getNonNullableType(type);
    if (type.isUnionOrIntersection()) return type.types.some((part) => isBinding(part, name));
    return (type.getSymbol()?.name ?? type.target?.getSymbol()?.name) === name;
  };
  const members = env.getProperties().map((symbol) => ({ name: symbol.name, type: checker.getTypeOfSymbolAtLocation(symbol, source) }));
  const d1 = members.filter((m) => isBinding(m.type, "D1Database")).map((m) => m.name);
  const producers = members.filter((m) => isBinding(m.type, "Queue")).map((m) => m.name);
  if (!d1.length || !producers.length) throw new Error("derivation found no D1/Queue bindings in the Worker Env");
  return { d1, producers, hasQueue: !!handler("queue"), hasScheduled: !!handler("scheduled") };
}

function checkPolicy(file, cfg) {
  const errs = [];
  if (/AUTH_MODE|stub/i.test(JSON.stringify(cfg))) errs.push(`${file}: must not set AUTH_MODE or stub`);
  // Credentials belong in Wrangler secrets, including any future *_SECRET/API_KEY keys.
  for (const key of Object.keys(cfg.vars ?? {})) {
    if (/(?:SECRET|PASSWORD|PRIVATE_KEY|API_KEY|TOKEN)$/i.test(key)) errs.push(`${file}: secret ${key} must not be set in vars`);
  }
  for (const [name, env] of Object.entries(cfg.env ?? {})) errs.push(...checkPolicy(`${file} env.${name}`, env));
  return errs;
}

export function check(file, cfg, bindings) {
  const errs = checkPolicy(file, cfg);
  const dbs = cfg.d1_databases ?? [];
  for (const b of bindings.d1) {
    const e = dbs.find((x) => x.binding === b);
    if (!e) errs.push(`${file}: D1 binding ${b} (used by worker code) is not declared in d1_databases`);
    else if (!e.database_name || !e.database_id) errs.push(`${file}: D1 binding ${b} needs database_name and database_id`);
  }
  for (const db of dbs) if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(db.database_id ?? "")) errs.push(`${file}: D1 binding ${db.binding} needs a UUID database_id`);
  const prods = cfg.queues?.producers ?? [];
  for (const b of bindings.producers) if (!prods.some((x) => x.binding === b && x.queue)) errs.push(`${file}: queue producer ${b} is not declared in queues.producers`);
  if (bindings.hasQueue) {
    for (const q of prods.map((p) => p.queue)) if (!(cfg.queues?.consumers ?? []).some((c) => c.queue === q)) errs.push(`${file}: worker exports queue() but queue ${q} has no entry in queues.consumers`);
    if (!prods.length) errs.push(`${file}: worker exports queue() but no queue is declared`);
  }
  const crons = cfg.triggers?.crons ?? [];
  if (bindings.hasScheduled && !crons.length) errs.push(`${file}: worker exports scheduled() but triggers.crons is empty`);
  return errs;
}

function checkLive(file, cfg) {
  const errs = checkPolicy(file, cfg);
  if ((cfg.d1_databases ?? []).length || (cfg.queues?.producers ?? []).length || (cfg.queues?.consumers ?? []).length || (cfg.triggers?.crons ?? []).length) errs.push(`${file}: live deployment must not enable D1, queues or cron triggers; use the opt-in binding examples`);
  for (const [name, env] of Object.entries(cfg.env ?? {})) errs.push(...checkLive(`${file} env.${name}`, env));
  return errs;
}

export function validate(directory = root) {
  const bindings = deriveBindings(directory);
  const read = (file) => parseJsonc(file, readFileSync(join(directory, file), "utf8"));
  const examples = exampleFiles.map((file) => read(file));
  const errs = liveFiles.flatMap((file) => checkLive(file, read(file)));
  examples.forEach((cfg, i) => errs.push(...check(exampleFiles[i], cfg, bindings)));
  // Include consumers: a consumer alone can attach staging to production's queue.
  const resources = (cfg) => [...(cfg.d1_databases ?? []).flatMap((d) => [d.database_id, d.database_name]), ...(cfg.queues?.producers ?? []).map((q) => q.queue), ...(cfg.queues?.consumers ?? []).map((q) => q.queue)].filter(Boolean);
  const staging = new Set(resources(examples[1]));
  const shared = [...new Set(resources(examples[0]).filter((x) => staging.has(x)))];
  if (shared.length) errs.push(`production and staging share resources: ${shared.join(", ")}`);
  return { errs, bindings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { errs, bindings } = validate();
    if (errs.length) throw new Error(errs.join("\n"));
    console.log(`bindings ok: D1 [${bindings.d1}] queue producers [${bindings.producers}]; live configs disabled; examples validated`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
