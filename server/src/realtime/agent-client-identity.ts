import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createSecureContext } from "node:tls";

export type AgentClientIdentity = { certificatePem: string; keyPem: string };

/** The Server presents this certificate to Agents. It never sends the private key to a NAS. */
export function loadAgentClientIdentity(certPath: string, keyPath: string): AgentClientIdentity | null {
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) throw new Error("Agent client certificate and private key paths must both be set");
  const stat = statSync(keyPath);
  if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error("Server Agent TLS private key must be a regular file with private permissions (0600)");
  }
  const certificatePem = readFileSync(certPath, "utf8");
  const keyPem = readFileSync(keyPath, "utf8");
  const cert = new X509Certificate(certificatePem);
  const now = Date.now();
  if (cert.ca || Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now ||
      !cert.keyUsage?.some((usage) => usage === "TLS Web Client Authentication" || usage === "1.3.6.1.5.5.7.3.2")) {
    throw new Error("Server Agent client certificate must be valid for TLS client authentication");
  }
  const privateKey = createPrivateKey(keyPem);
  if (!createPublicKey(privateKey).equals(cert.publicKey)) {
    throw new Error("Server Agent TLS certificate and private key do not match");
  }
  createSecureContext({ cert: certificatePem, key: keyPem });
  return { certificatePem, keyPem };
}
