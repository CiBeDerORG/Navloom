import { createRequire } from "node:module";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TemplateSchema, type CatalogTemplate } from "./template.js";

type Yaml = { load(source: string): unknown };
const yaml = createRequire(import.meta.url)("js-yaml") as Yaml;
export const BUILTIN_TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../templates/builtin");

export type TemplateSummary = Pick<CatalogTemplate, "id" | "version" | "title" | "description" | "category" | "icon" | "architectures">;

/**
 * Catalog files are shipped with the installed Navloom version, not fetched
 * from arbitrary URLs or deploy repositories. Reject symlinks, oversized YAML,
 * unknown fields and duplicate template IDs. Any invalid trusted file fails
 * startup closed rather than silently becoming an installable application.
 */
export function loadBuiltinCatalog(directory = BUILTIN_TEMPLATE_DIR): ReadonlyMap<string, CatalogTemplate> {
  const found = new Map<string, CatalogTemplate>();
  const entries = readdirSync(directory).filter((name) => /^[a-z][a-z0-9-]*\.ya?ml$/.test(name)).sort();
  for (const name of entries) {
    const file = join(directory, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) {
      throw new Error("Unsafe or oversized trusted catalog entry: " + name);
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(readFileSync(file, "utf8"));
    } catch {
      throw new Error("Invalid YAML in trusted catalog entry: " + name);
    }
    const result = TemplateSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("Invalid trusted catalog entry " + name + ": " +
        result.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; "));
    }
    if (found.has(result.data.id)) throw new Error("Duplicate trusted template ID: " + result.data.id);
    found.set(result.data.id, result.data);
  }
  return found;
}

export function listTemplateSummaries(catalog: ReadonlyMap<string, CatalogTemplate>,
  query: { search?: string; category?: string } = {}): TemplateSummary[] {
  const needle = query.search?.trim().toLocaleLowerCase() ?? "";
  const category = query.category?.trim().toLocaleLowerCase() ?? "";
  return [...catalog.values()].filter((item) => {
    if (category && item.category.toLocaleLowerCase() !== category) return false;
    return !needle || [item.id, item.title, item.description, item.category]
      .some((text) => text.toLocaleLowerCase().includes(needle));
  }).map(({ id, version, title, description, category: group, icon, architectures }) =>
    ({ id, version, title, description, category: group, icon, architectures }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
