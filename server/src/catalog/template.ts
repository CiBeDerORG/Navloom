import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
const fieldId = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const serviceId = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const caption = z.string().trim().min(1).max(120);
const description = z.string().trim().max(1500);

const common = { title: caption, description: description.optional(), secret: z.boolean().optional() };
const stringField = z.object({
  ...common, type: z.literal("string"), default: z.string().max(512).optional(),
  enum: z.array(z.string().max(512)).min(1).max(50).optional(),
  minLength: z.number().int().min(0).max(512).optional(),
  maxLength: z.number().int().min(1).max(512).optional(),
  format: z.enum(["plain", "absolute-path"]).optional(),
}).strict();
const integerField = z.object({
  ...common, type: z.literal("integer"), default: z.number().int().safe().optional(),
  minimum: z.number().int().safe().optional(),
  maximum: z.number().int().safe().optional(),
  enum: z.array(z.number().int().safe()).min(1).max(50).optional(),
  format: z.literal("port").optional(),
}).strict();
const booleanField = z.object({
  ...common, type: z.literal("boolean"), default: z.boolean().optional(),
}).strict();
export const ParameterFieldSchema = z.discriminatedUnion("type", [stringField, integerField, booleanField]);
export type ParameterField = z.infer<typeof ParameterFieldSchema>;

const parameterSchema = z.object({
  type: z.literal("object"),
  additionalProperties: z.literal(false),
  required: z.array(fieldId).max(40).default([]),
  properties: z.record(fieldId, ParameterFieldSchema).refine(
    (properties) => Object.keys(properties).length <= 40, "too many template parameters",
  ),
}).strict().superRefine((schema, ctx) => {
  const names = Object.keys(schema.properties);
  if (new Set(schema.required).size !== schema.required.length ||
      schema.required.some((key) => !names.includes(key))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "required references an unknown or duplicate parameter" });
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    if (field.secret && field.type !== "string") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "secret fields must be strings", path: ["properties", name] });
    }
    if (field.secret && field.default !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "secret defaults are forbidden", path: ["properties", name] });
    }
    if (field.type === "string" && field.minLength !== undefined && field.maxLength !== undefined &&
      field.minLength > field.maxLength) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid string length bounds", path: ["properties", name] });
    }
    if (field.type === "integer" && field.minimum !== undefined && field.maximum !== undefined &&
      field.minimum > field.maximum) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid integer bounds", path: ["properties", name] });
    }
    if (field.default !== undefined && !valueAllowed(field, field.default)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "default violates parameter constraints", path: ["properties", name, "default"] });
    }
  }
});

const binding = z.object({ parameter: fieldId }).strict();
const port = z.object({
  container: z.number().int().min(1).max(65535),
  hostParameter: fieldId,
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
}).strict();
const volume = z.object({
  name: serviceId,
  target: z.string().regex(/^\/[a-zA-Z0-9_./-]{1,250}$/),
}).strict();
const service = z.object({
  name: serviceId,
  image: z.string().min(3).max(300).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/),
  ports: z.array(port).max(20).default([]),
  environment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), binding).default({}),
  volumes: z.array(volume).max(15).default([]),
}).strict();

export const TemplateSchema = z.object({
  apiVersion: z.literal("navloom/v1"),
  id, version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  title: caption, description, category: caption,
  icon: z.string().max(250).optional(),
  architectures: z.array(z.enum(["amd64", "arm64"])).min(1).max(2),
  parameters: parameterSchema,
  compose: z.object({
    services: z.array(service).min(1).max(12),
  }).strict(),
  navigation: z.object({
    title: caption, icon: z.string().max(250).optional(),
    url: z.string().url().max(2048).optional(),
  }).strict(),
}).strict().superRefine((template, ctx) => {
  const fields = template.parameters.properties;
  const serviceNames = new Set<string>();
  for (const [i, entry] of template.compose.services.entries()) {
    if (serviceNames.has(entry.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate service", path: ["compose", "services", i, "name"] });
    }
    serviceNames.add(entry.name);
    for (const [j, port] of entry.ports.entries()) {
      const field = fields[port.hostParameter];
      if (!field || field.type !== "integer" || field.format !== "port") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host port requires a declared port parameter",
          path: ["compose", "services", i, "ports", j, "hostParameter"] });
      }
    }
    for (const [key, reference] of Object.entries(entry.environment)) {
      if (!fields[reference.parameter]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unknown environment parameter",
          path: ["compose", "services", i, "environment", key] });
      }
    }
    for (const [j, mount] of entry.volumes.entries()) {
      if (mount.target.split("/").includes("..") || mount.target.startsWith("//")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid volume target", path: ["compose", "services", i, "volumes", j] });
      }
    }
  }
});
export type CatalogTemplate = z.infer<typeof TemplateSchema>;

function validPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") ||
      value.split("/").includes("..") || value.split("/").includes(".") || value.length > 250) return false;
  return /^\/[a-zA-Z0-9_./-]+$/.test(value);
}

function valueAllowed(field: ParameterField, value: unknown): boolean {
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "integer") {
    return typeof value === "number" && Number.isSafeInteger(value) &&
      (field.minimum === undefined || value >= field.minimum) &&
      (field.maximum === undefined || value <= field.maximum) &&
      (!field.enum || field.enum.includes(value)) &&
      (field.format !== "port" || (value >= 1 && value <= 65535));
  }
  return typeof value === "string" && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    (field.minLength === undefined || value.length >= field.minLength) &&
    (field.maxLength === undefined || value.length <= field.maxLength) &&
    (!field.enum || field.enum.includes(value)) &&
    (field.format !== "absolute-path" || validPath(value));
}

/**
 * This validator is intentionally shared by future API handlers and the Web
 * form. It returns only normalized values; unknown inputs and shell-esque
 * paths never make it into a Compose render.
 */
export function validateTemplateParameters(template: CatalogTemplate, input: unknown): Record<string, string | number | boolean> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Installation parameters must be an object");
  }
  const raw = input as Record<string, unknown>;
  const properties = template.parameters.properties;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(properties, key)) throw new Error("Unknown installation parameter: " + key);
  }
  const output: Record<string, string | number | boolean> = Object.create(null) as Record<string, string | number | boolean>;
  for (const [key, field] of Object.entries(properties)) {
    const value = Object.hasOwn(raw, key) ? raw[key] : field.default;
    if (value === undefined) {
      if (template.parameters.required.includes(key)) throw new Error("Missing required parameter: " + key);
      continue;
    }
    if (!valueAllowed(field, value)) throw new Error("Invalid value for parameter: " + key);
    output[key] = value as string | number | boolean;
  }
  return output;
}

export type RenderedCompose = {
  name: string;
  services: Record<string, { image: string; restart: "unless-stopped"; ports?: string[]; environment?: Record<string, string>; volumes?: string[] }>;
  volumes?: Record<string, Record<string, never>>;
};

/**
 * Only allowlisted Compose attributes can be emitted. No interpolation of a
 * user string into YAML, shell, command, image, privileged mode or host paths.
 * Real deployment and host-directory assignment belong to later M3 tasks.
 */
export function renderTrustedCompose(template: CatalogTemplate, parameters: unknown, suffix: string): RenderedCompose {
  if (!/^[a-z0-9]{8,24}$/.test(suffix)) throw new Error("Invalid installation instance suffix");
  const values = validateTemplateParameters(template, parameters);
  const name = "navloom-" + template.id + "-" + suffix;
  if (name.length > 63) throw new Error("Compose project name exceeds 63 characters");
  const services: RenderedCompose["services"] = Object.create(null) as RenderedCompose["services"];
  const volumes: Record<string, Record<string, never>> = Object.create(null) as Record<string, Record<string, never>>;
  for (const entry of template.compose.services) {
    const out: RenderedCompose["services"][string] = { image: entry.image, restart: "unless-stopped" };
    if (entry.ports.length) {
      out.ports = entry.ports.map((port) => {
        const host = values[port.hostParameter];
        if (typeof host !== "number") throw new Error("Missing port parameter: " + port.hostParameter);
        return "127.0.0.1:" + host + ":" + port.container + "/" + port.protocol;
      });
    }
    if (Object.keys(entry.environment).length) {
      out.environment = Object.fromEntries(Object.entries(entry.environment).map(([env, ref]) => {
        const value = values[ref.parameter];
        if (value === undefined) throw new Error("Missing environment parameter: " + ref.parameter);
        return [env, String(value)];
      }));
    }
    if (entry.volumes.length) {
      out.volumes = entry.volumes.map((volume) => {
        const volumeName = template.id + "_" + volume.name;
        volumes[volumeName] = {};
        return volumeName + ":" + volume.target;
      });
    }
    services[entry.name] = out;
  }
  return { name, services, ...(Object.keys(volumes).length ? { volumes } : {}) };
}
