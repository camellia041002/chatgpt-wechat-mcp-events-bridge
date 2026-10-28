import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function requireText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength) {
    throw new Error(`${label} must be 1-${maxLength} characters`);
  }
  return text;
}

export function optionalText(value, maxLength) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw new Error(`value must be at most ${maxLength} characters`);
  return text;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(temp, filePath);
  } catch (error) {
    if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temp, filePath);
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows best effort */ }
}

export function readJson(filePath, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

export function normalizeAccountId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function redactSensitiveText(input, maxLength = 800) {
  const fields = "context_token|bot_token|token|authorization|aeskey|aes_key|secret|refresh_token|access_token";
  const jsonPattern = new RegExp(`\"(${fields})\"\\s*:\\s*\"[^\"]*\"`, "gi");
  const queryPattern = new RegExp(`([?&](?:${fields})=)[^&\\s]+`, "gi");
  const redacted = String(input ?? "")
    .replace(jsonPattern, '"$1":"<redacted>"')
    .replace(queryPattern, "$1<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>");
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…`;
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

