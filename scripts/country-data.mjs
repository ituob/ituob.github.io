import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export const countryLabels = value => typeof value === "string" ? [value] : Object.values(value ?? {}).filter(v => typeof v === "string");

/** All structured datasets, including ones not yet exposed by the submission catalog. */
export function countryData(dataRoot) {
  const read = path => parse(readFileSync(resolve(dataRoot, path), "utf8"));
  const { registers } = read("catalogs/registers.yaml");
  return readdirSync(resolve(dataRoot, "datasets")).sort().flatMap(directory => {
    const path = `datasets/${directory}`;
    if (!existsSync(resolve(dataRoot, path, "data.yaml"))) return [];
    const schema = read(`${path}/schema-data.yaml`);
    const fields = Object.keys(schema?.items?.properties ?? {}).filter(f => ["country", "country_or_area", "country_area_or_service", "area_or_network"].includes(f));
    if (!fields.length) return [];
    const register = registers.find(r => r.seed_path === path || r.slug === directory);
    const rows = read(`${path}/data.yaml`);
    if (!Array.isArray(rows)) throw new Error(`Expected country rows at ${path}`);
    return [{ register: register?.register_id ?? directory, path, fields, rows }];
  });
}
