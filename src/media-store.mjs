import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES_PER_EVENT = 4;
const ALLOWED_DIRECT_HOST_SUFFIXES = [".weixin.qq.com", ".qpic.cn"];

export function extractInboundImageRefs(itemList) {
  if (!Array.isArray(itemList)) return [];
  const result = [];
  for (let index = 0; index < itemList.length && result.length < MAX_IMAGES_PER_EVENT; index += 1) {
    const item = itemList[index];
    if (Number(item?.type) !== 2 || !item?.image_item || typeof item.image_item !== "object") continue;
    const body = item.image_item;
    const media = body.media && typeof body.media === "object" ? body.media : {};
    const ref = {
      index,
      directUrls: uniqueStrings([body.url, body.download_url, body.cdn_url, media.url, media.download_url, media.cdn_url]),
      encryptQueryParam: firstText(media.encrypt_query_param, media.encrypted_query_param, body.encrypt_query_param, body.encrypted_query_param),
      aesKey: firstText(media.aes_key, body.aes_key, item.aes_key),
      aesKeyHex: firstText(body.aeskey, body.aes_key_hex, item.aeskey),
      encryptType: Number(media.encrypt_type ?? body.encrypt_type ?? item.encrypt_type ?? 1),
      fileKey: firstText(media.filekey, body.filekey, item.filekey),
    };
    if (ref.directUrls.length || ref.encryptQueryParam) result.push(ref);
  }
  return result;
}

export async function persistInboundImages({
  imageRefs,
  stateDir,
  eventId,
  receivedAt,
  cdnBaseUrl = DEFAULT_CDN_BASE_URL,
  fetchFn = fetch,
} = {}) {
  const images = [];
  const errors = [];
  for (let outputIndex = 0; outputIndex < Math.min(imageRefs?.length || 0, MAX_IMAGES_PER_EVENT); outputIndex += 1) {
    try {
      const downloaded = await downloadImage(imageRefs[outputIndex], { cdnBaseUrl, fetchFn });
      const plaintext = decodeImage(downloaded.bytes, imageRefs[outputIndex]);
      const detected = detectImage(plaintext);
      if (!detected) throw new Error("downloaded payload is not a supported image");
      const day = safeDay(receivedAt);
      const relativePath = path.posix.join("media", day, `${safeEventId(eventId)}-${outputIndex + 1}.${detected.extension}`);
      const absolutePath = resolveMediaPath(stateDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
      await writeImageAtomically(absolutePath, plaintext);
      images.push({
        index: outputIndex,
        relativePath,
        mimeType: detected.mimeType,
        sizeBytes: plaintext.length,
        sha256: hashBytes(plaintext),
      });
    } catch (error) {
      errors.push({ index: outputIndex, code: classifyImageError(error) });
    }
  }
  return { images, errors };
}

export async function readStoredImage({ stateDir, relativePath }) {
  const absolutePath = resolveMediaPath(stateDir, relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new Error("stored image is unavailable");
  const bytes = await fs.readFile(absolutePath);
  const detected = detectImage(bytes);
  if (!detected) throw new Error("stored media is not a supported image");
  return { bytes, mimeType: detected.mimeType, sizeBytes: bytes.length, sha256: hashBytes(bytes) };
}

async function downloadImage(ref, { cdnBaseUrl, fetchFn }) {
  const candidates = buildCandidates(ref, cdnBaseUrl);
  if (!candidates.length) throw new Error("image did not include a supported download reference");
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetchFn(candidate, {
        method: "GET",
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5" },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`image download HTTP ${response.status}`);
      return { bytes: await readLimitedBody(response, MAX_IMAGE_BYTES) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("image download failed");
}

function buildCandidates(ref, cdnBaseUrl) {
  const candidates = [];
  const seen = new Set();
  const configuredBase = new URL(String(cdnBaseUrl || DEFAULT_CDN_BASE_URL));
  if (configuredBase.protocol !== "https:") throw new Error("image CDN must use HTTPS");
  for (const rawUrl of ref?.directUrls || []) {
    let url;
    try { url = new URL(rawUrl); } catch { continue; }
    if (url.protocol !== "https:" || !isAllowedImageHost(url.hostname, configuredBase.hostname)) continue;
    addCandidate(candidates, seen, url.toString());
  }
  if (ref?.encryptQueryParam) {
    const url = new URL("download", `${configuredBase.toString().replace(/\/+$/g, "")}/`);
    url.searchParams.set("encrypted_query_param", ref.encryptQueryParam);
    if (ref.fileKey) url.searchParams.set("filekey", ref.fileKey);
    addCandidate(candidates, seen, url.toString());
  }
  return candidates;
}

function isAllowedImageHost(hostname, configuredHostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (normalized === String(configuredHostname || "").toLowerCase()) return true;
  return ALLOWED_DIRECT_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

async function readLimitedBody(response, limit) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error("image exceeds size limit");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("image exceeds size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function decodeImage(bytes, ref) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("empty image payload");
  const keyCandidates = decodeAesKeys(ref);
  if (Number(ref?.encryptType) !== 1 || !keyCandidates.length) return bytes;
  for (const key of keyCandidates) {
    try {
      const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
      decipher.setAutoPadding(true);
      const plaintext = Buffer.concat([decipher.update(bytes), decipher.final()]);
      if (detectImage(plaintext)) return plaintext;
    } catch {
      // Try the next supported key encoding.
    }
  }
  if (detectImage(bytes)) return bytes;
  throw new Error("image decryption failed");
}

function decodeAesKeys(ref) {
  const result = [];
  const seen = new Set();
  for (const value of [ref?.aesKeyHex, ref?.aesKey]) {
    const text = String(value || "").trim();
    const candidates = [];
    if (/^[0-9a-f]{32}$/i.test(text)) candidates.push(Buffer.from(text, "hex"));
    if (text.length === 16) candidates.push(Buffer.from(text, "utf8"));
    if (text) {
      const decoded = Buffer.from(text, "base64");
      if (decoded.length === 16) candidates.push(decoded);
      const decodedText = decoded.toString("utf8").trim();
      if (/^[0-9a-f]{32}$/i.test(decodedText)) candidates.push(Buffer.from(decodedText, "hex"));
    }
    for (const candidate of candidates) {
      const id = candidate.toString("hex");
      if (candidate.length === 16 && !seen.has(id)) {
        seen.add(id);
        result.push(candidate);
      }
    }
  }
  return result;
}

function detectImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    return { mimeType: "image/gif", extension: "gif" };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}

function resolveMediaPath(stateDir, relativePath) {
  const root = path.resolve(stateDir, "media");
  const target = path.resolve(stateDir, String(relativePath || ""));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("invalid stored image path");
  return target;
}

function safeDay(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

function safeEventId(value) {
  return String(value || "event").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120) || "event";
}

function addCandidate(target, seen, value) {
  if (!value || seen.has(value)) return;
  seen.add(value);
  target.push(value);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function firstText(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function classifyImageError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("size limit") || message.includes("exceeds")) return "image_too_large";
  if (message.includes("decrypt")) return "image_decrypt_failed";
  if (message.includes("supported image")) return "unsupported_image";
  if (message.includes("http") || message.includes("download") || message.includes("timeout")) return "image_download_failed";
  return "image_store_failed";
}

function hashBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function writeImageAtomically(absolutePath, bytes) {
  try {
    await fs.writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await fs.readFile(absolutePath);
    if (existing.length !== bytes.length || hashBytes(existing) !== hashBytes(bytes)) {
      throw new Error("stored image path already contains different content");
    }
  }
}

export { DEFAULT_CDN_BASE_URL, MAX_IMAGE_BYTES, MAX_IMAGES_PER_EVENT };
