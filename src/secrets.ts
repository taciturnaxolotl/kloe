import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getConfig } from "./settings";

/**
 * Encryption at rest for credentials that belong to a *user* rather than to the
 * deployment: pasted API keys and OAuth refresh tokens (see credentials.ts).
 *
 * The deployment's own keys don't come through here — they live in the
 * EnvironmentFile and never touch the database. These do, and the database is
 * backed up nightly to somebody else's disk, so a key a guest handed us should
 * not be readable from a restic snapshot alone. The encryption key comes from
 * the environment, so the two halves are never in the same place.
 *
 * AES-256-GCM: the tag makes a tampered ciphertext fail loudly instead of
 * decrypting to garbage. Any passphrase works as the configured key — it is
 * hashed to the 32 bytes the cipher wants, so an operator can use `openssl rand
 * -hex 32` or a long phrase and neither is wrong.
 */

const VERSION = "v1";

/** Whether this deployment can store user credentials at all. */
export function encryptionConfigured(): boolean {
  return !!getConfig().security.credentialKey;
}

function cipherKey(): Buffer {
  const raw = getConfig().security.credentialKey;
  if (!raw) {
    throw new Error(
      "security.credentialKey is unset, so a user credential cannot be stored; set $KLOE_CREDENTIAL_KEY (e.g. `openssl rand -hex 32`)",
    );
  }
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), body]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decryptSecret(blob: string): string {
  const [version, iv, tag, body] = blob.split(".");
  if (version !== VERSION || !iv || !tag || !body) {
    throw new Error("stored credential is not in a format this version understands");
  }
  const decipher = createDecipheriv("aes-256-gcm", cipherKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return decipher.update(Buffer.from(body, "base64url")).toString("utf8") + decipher.final("utf8");
}

/**
 * Enough of a secret to recognize it by, and not enough to use.
 *
 * The settings page has to show a user *which* key they saved without being a
 * place to read it back: last four characters, the same shape every provider's
 * own dashboard uses.
 */
export function hint(secret: string): string {
  return secret.length <= 4 ? "••••" : `••••${secret.slice(-4)}`;
}
