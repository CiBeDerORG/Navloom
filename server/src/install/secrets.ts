import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Opaque data format for future task secret storage, not a logging format. */
export type SealedInstallParameters = string & { readonly __sealedInstall: unique symbol };

export function parseInstallEncryptionKey(encoded: string | undefined): Buffer {
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error("NAVLOOM_INSTALL_KEY must contain 32 random bytes in canonical base64url");
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) {
    throw new Error("Invalid NAVLOOM_INSTALL_KEY encoding");
  }
  return key;
}

function associatedData(taskId: string, agentId: string, templateId: string, version: string): Buffer {
  // Bind ciphertext to its intended task, target Agent and trusted template.
  return Buffer.from(JSON.stringify(["navloom-install-v1", taskId, agentId, templateId, version]), "utf8");
}

/**
 * AES-256-GCM protects installer parameters at rest. Keys come from external
 * runtime secrets only: no fallback, sample key or hardcoded encryption key.
 * Caller must NEVER put plaintext or output in task logs or API responses.
 */
export function sealInstallParameters(
  parameters: Record<string, string | number | boolean>,
  key: Buffer, taskId: string, agentId: string, templateId: string, version: string,
): SealedInstallParameters {
  if (key.length !== 32) throw new Error("Install encryption key must be 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associatedData(taskId, agentId, templateId, version));
  const plain = Buffer.from(JSON.stringify(parameters), "utf8");
  try {
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return ["v1", nonce.toString("base64url"), data.toString("base64url"),
      cipher.getAuthTag().toString("base64url")].join(":") as SealedInstallParameters;
  } finally {
    plain.fill(0);
  }
}

/** Only the eventual authenticated dispatcher may unseal a secret payload. */
export function unsealInstallParameters(
  sealed: SealedInstallParameters,
  key: Buffer, taskId: string, agentId: string, templateId: string, version: string,
): Record<string, string | number | boolean> {
  if (key.length !== 32) throw new Error("Install encryption key must be 32 bytes");
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Unsupported installation secret envelope");
  const nonce = Buffer.from(parts[1]!, "base64url");
  const data = Buffer.from(parts[2]!, "base64url");
  const tag = Buffer.from(parts[3]!, "base64url");
  if (nonce.length !== 12 || tag.length !== 16 || data.length > 65536) {
    throw new Error("Invalid installation secret envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(associatedData(taskId, agentId, templateId, version));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  try {
    const result: unknown = JSON.parse(plain.toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Invalid installation secret payload");
    }
    const values: Record<string, string | number | boolean> = Object.create(null) as Record<string, string | number | boolean>;
    for (const [name, value] of Object.entries(result)) {
      if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") {
        throw new Error("Invalid installation parameter type");
      }
      values[name] = value;
    }
    return values;
  } finally {
    plain.fill(0);
  }
}
