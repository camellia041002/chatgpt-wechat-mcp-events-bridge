import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectOfficeFile, MAX_EXTRACTED_TEXT_CHARS } from "./office-text.mjs";

const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_EVENT = 4;
const MAX_FILE_STORAGE_BYTES = 1024 * 1024 * 1024;
const FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_DIRECT_HOST_SUFFIXES = [".weixin.qq.com", ".qpic.cn"];

const FILE_TYPES = new Map([
  [".pdf", { mimeType: "application/pdf", family: "pdf" }],
  [".docx", { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", family: "zip" }],
  [".pptx", { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", family: "zip" }],
  [".xlsx", { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", family: "zip" }],
  [".xls", { mimeType: "application/vnd.ms-excel", family: "ole" }],
  [".txt", { mimeType: "text/plain", family: "text" }],
  [".csv", { mimeType: "text/csv", family: "text" }],
  [".tsv", { mimeType: "text/tab-separated-values", family: "text" }],
  [".wav", { mimeType: "audio/wav", family: "audio", audioFormat: "wav" }],
  [".mp3", { mimeType: "audio/mpeg", family: "audio", audioFormat: "mp3" }],
  [".mpeg", { mimeType: "audio/mpeg", family: "audio", audioFormat: "mp3" }],
  [".ogg", { mimeType: "audio/ogg", family: "audio", audioFormat: "ogg" }],
  [".oga", { mimeType: "audio/ogg", family: "audio", audioFormat: "ogg" }],
  [".flac", { mimeType: "audio/flac", family: "audio", audioFormat: "flac" }],
  [".aac", { mimeType: "audio/aac", family: "audio", audioFormat: "aac" }],
  [".m4a", { mimeType: "audio/mp4", family: "audio", audioFormat: "m4a" }],
]);

export function extractInboundFileRefs(itemList) {
  if (!Array.isArray(itemList)) return [];
  const result = [];
  for (let index = 0; index < itemList.length && result.length < MAX_FILES_PER_EVENT; index += 1) {
    const item = itemList[index];
    if (Number(item?.type) !== 4 || !item?.file_item || typeof item.file_item !== "object") continue;
    const body = item.file_item;
    const media = body.media && typeof body.media === "object" ? body.media : {};
    result.push({
      index,
      fileName: safeFileName(body.file_name || body.filename || ""),
      declaredSize: positiveInteger(body.len ?? body.size ?? body.file_size),
      declaredMd5: String(body.md5 || "").trim().toLowerCase(),
      directUrls: uniqueStrings([body.url, body.download_url, body.cdn_url, media.full_url, media.url, media.download_url, media.cdn_url]),
      encryptQueryParam: firstText(media.encrypt_query_param, media.encrypted_query_param, body.encrypt_query_param, body.encrypted_query_param),
      aesKey: firstText(media.aes_key, body.aes_key, item.aes_key),
      aesKeyHex: firstText(body.aeskey, body.aes_key_hex, item.aeskey),
      fileKey: firstText(media.filekey, body.filekey, item.filekey),
    });
  }
  return result;
}

export async function persistInboundFiles({
  fileRefs,
  stateDir,
  eventId,
  receivedAt,
  cdnBaseUrl = DEFAULT_CDN_BASE_URL,
  fetchFn = fetch,
  retainedFiles = [],
  now = new Date(),
  maxStorageBytes = MAX_FILE_STORAGE_BYTES,
} = {}) {
  const files = [];
  const errors = [];
  try {
    await pruneOrphanedFiles({ stateDir, retainedFiles, now });
  } catch {
    // Capacity enforcement below still fails closed if cleanup is unavailable.
  }
  for (let outputIndex = 0; outputIndex < Math.min(fileRefs?.length || 0, MAX_FILES_PER_EVENT); outputIndex += 1) {
    const ref = fileRefs[outputIndex];
    try {
      const declared = FILE_TYPES.get(path.extname(ref.fileName).toLowerCase());
      if (!declared) throw new Error("unsupported file type");
      if (ref.declaredSize && ref.declaredSize > MAX_FILE_BYTES) throw new Error("file exceeds size limit");
      const encrypted = await downloadFile(ref, { cdnBaseUrl, fetchFn });
      const plaintext = decodeFile(encrypted, ref, declared);
      validateFile(plaintext, declared);
      if (ref.declaredSize && plaintext.length !== ref.declaredSize) throw new Error("file size mismatch");
      if (/^[a-f0-9]{32}$/.test(ref.declaredMd5) && md5(plaintext) !== ref.declaredMd5) throw new Error("file integrity mismatch");
      const extension = path.extname(ref.fileName).toLowerCase();
      const extraction = await extractFileText(plaintext, extension, declared);
      const relativePath = path.posix.join("files", safeDay(receivedAt), `${safeEventId(eventId)}-${outputIndex + 1}${extension}`);
      const textRelativePath = extraction.text
        ? path.posix.join("files", safeDay(receivedAt), `${safeEventId(eventId)}-${outputIndex + 1}${extension}.txt`)
        : "";
      const absolutePath = resolveFilePath(stateDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
       await ensureStorageCapacity(stateDir, absolutePath, plaintext.length, maxStorageBytes);
      await writeFileAtomically(absolutePath, plaintext);
      if (textRelativePath) {
        const textBytes = Buffer.from(extraction.text, "utf8");
        const textAbsolutePath = resolveFilePath(stateDir, textRelativePath);
         await ensureStorageCapacity(stateDir, textAbsolutePath, textBytes.length, maxStorageBytes);
        await writeFileAtomically(textAbsolutePath, textBytes);
      }
      files.push({
        index: outputIndex,
        relativePath,
        fileName: ref.fileName,
        mimeType: declared.mimeType,
        sizeBytes: plaintext.length,
        sha256: hashBytes(plaintext),
        extractionStatus: extraction.status,
        extractedCharacterCount: extraction.characterCount,
        textTruncated: extraction.truncated,
        textRelativePath,
        textSha256: extraction.text ? hashBytes(Buffer.from(extraction.text, "utf8")) : "",
      });
    } catch (error) {
      errors.push({ index: outputIndex, fileName: ref.fileName || "", code: classifyFileError(error) });
    }
  }
  return { files, errors };
}

export async function readStoredFile({ stateDir, relativePath, expectedFileName = "", extraction = {} }) {
  const absolutePath = resolveFilePath(stateDir, relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw new Error("stored file is unavailable");
  const bytes = await fs.readFile(absolutePath);
  const fileName = safeFileName(expectedFileName || path.basename(relativePath));
  const declared = FILE_TYPES.get(path.extname(fileName).toLowerCase());
  if (!declared) throw new Error("stored file type is unsupported");
  validateFile(bytes, declared);
  let extractedText = "";
  if (extraction.textRelativePath) {
    const textPath = resolveFilePath(stateDir, extraction.textRelativePath);
    const textBytes = await fs.readFile(textPath);
    if (textBytes.length > MAX_EXTRACTED_TEXT_CHARS * 4) throw new Error("stored extracted text is unavailable");
    if (hashBytes(textBytes) !== extraction.textSha256) throw new Error("stored extracted text integrity check failed");
    extractedText = textBytes.toString("utf8");
  }
  return {
    bytes,
    fileName,
    mimeType: declared.mimeType,
    sizeBytes: bytes.length,
    sha256: hashBytes(bytes),
    extractionStatus: String(extraction.extractionStatus || "unavailable"),
    extractedText,
    extractedCharacterCount: Number(extraction.extractedCharacterCount) || 0,
    textTruncated: Boolean(extraction.textTruncated),
  };
}

export async function pruneOrphanedFiles({ stateDir, retainedRelativePaths = [], retainedFiles = [], now = new Date() } = {}) {
  const root = path.resolve(stateDir, "files");
  const tombstoneRoot = path.resolve(stateDir, "files-prune");
  const retained = new Map(retainedRelativePaths.map((value) => [resolveFilePath(stateDir, value), Number.POSITIVE_INFINITY]));
  for (const item of retainedFiles) {
    const receivedAt = Date.parse(String(item?.receivedAt || ""));
    if (!item?.relativePath || !Number.isFinite(receivedAt)) continue;
    retained.set(resolveFilePath(stateDir, item.relativePath), receivedAt + FILE_TTL_MS);
  }
  await fs.rm(tombstoneRoot, { recursive: true, force: true });
  let removedFiles = 0;
  let removedBytes = 0;
  for (const absolutePath of await listFiles(root)) {
    if ((retained.get(absolutePath) ?? 0) > now.getTime()) continue;
    const stat = await fs.stat(absolutePath);
    await fs.mkdir(tombstoneRoot, { recursive: true, mode: 0o700 });
    const tombstone = path.join(tombstoneRoot, `${crypto.randomBytes(12).toString("hex")}.deleted`);
    await fs.rename(absolutePath, tombstone);
    await fs.unlink(tombstone);
    removedFiles += 1;
    removedBytes += stat.size;
  }
  await removeEmptyDirectories(root);
  await fs.rm(tombstoneRoot, { recursive: true, force: true });
  return { removedFiles, removedBytes };
}

async function extractFileText(bytes, extension, declared) {
  if (declared.family === "text") {
    const full = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      status: "extracted",
      text: full.slice(0, MAX_EXTRACTED_TEXT_CHARS),
      characterCount: full.length,
      truncated: full.length > MAX_EXTRACTED_TEXT_CHARS,
    };
  }
  if (declared.family === "zip") {
    const result = await inspectOfficeFile(bytes, extension);
    return { status: "extracted", ...result };
  }
  return { status: "unavailable", text: "", characterCount: 0, truncated: false };
}

async function downloadFile(ref, { cdnBaseUrl, fetchFn }) {
  const candidates = buildCandidates(ref, cdnBaseUrl);
  if (!candidates.length) throw new Error("file did not include a supported download reference");
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetchFn(candidate, {
        method: "GET",
        headers: { Accept: "application/octet-stream,*/*;q=0.5" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`file download HTTP ${response.status}`);
      return await readLimitedBody(response, MAX_FILE_BYTES + 32);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("file download failed");
}

function buildCandidates(ref, cdnBaseUrl) {
  const candidates = [];
  const seen = new Set();
  const configuredBase = new URL(String(cdnBaseUrl || DEFAULT_CDN_BASE_URL));
  if (configuredBase.protocol !== "https:") throw new Error("file CDN must use HTTPS");
  for (const rawUrl of ref?.directUrls || []) {
    let url;
    try { url = new URL(rawUrl); } catch { continue; }
    if (url.protocol !== "https:" || !isAllowedHost(url.hostname, configuredBase.hostname)) continue;
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

function decodeFile(bytes, ref, declared) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("empty file payload");
  const keys = decodeAesKeys(ref);
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
      decipher.setAutoPadding(true);
      const plaintext = Buffer.concat([decipher.update(bytes), decipher.final()]);
      validateFile(plaintext, declared);
      return plaintext;
    } catch {
      // Try another supported key encoding, then plaintext as a compatibility fallback.
    }
  }
  try {
    validateFile(bytes, declared);
    return bytes;
  } catch {
    if (keys.length) throw new Error("file decryption failed");
    throw new Error("file type mismatch");
  }
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

function validateFile(bytes, declared) {
  if (!bytes.length) throw new Error("empty file payload");
  if (declared.family === "pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("file type mismatch");
  if (declared.family === "zip" && !isZip(bytes)) throw new Error("file type mismatch");
  if (declared.family === "ole" && !bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) throw new Error("file type mismatch");
  if (declared.family === "text") validateText(bytes);
  if (declared.family === "audio" && !looksLikeAudio(bytes, declared.audioFormat)) throw new Error("file type mismatch");
}

function validateText(bytes) {
  if (bytes.includes(0)) throw new Error("file type mismatch");
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("text file is not valid UTF-8"); }
}

function looksLikeAudio(bytes, format) {
  const head = bytes.subarray(0, 12).toString("ascii");
  if (format === "wav") return head.startsWith("RIFF") && head.slice(8, 12) === "WAVE";
  if (format === "mp3") return head.startsWith("ID3") || isMpegAudioFrame(bytes);
  if (format === "ogg") return head.startsWith("OggS");
  if (format === "flac") return head.startsWith("fLaC");
  if (format === "aac") return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (format === "m4a") return looksLikeM4a(bytes);
  return false;
}

function isMpegAudioFrame(bytes) {
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0;
}

function looksLikeM4a(bytes) {
  if (bytes.length < 24 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") return false;
  let hasAudioTrack = false;
  for (let offset = 0; offset + 16 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    if (size < 8 || offset + size > bytes.length) break;
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "moov") {
      const body = bytes.subarray(offset + 8, offset + size);
      for (let index = 0; index + 16 <= body.length; index += 1) {
        if (body.subarray(index, index + 4).toString("ascii") !== "hdlr") continue;
        const handler = body.subarray(index + 12, index + 16).toString("ascii");
        if (handler === "vide") return false;
        if (handler === "soun") hasAudioTrack = true;
      }
    }
    offset += size;
  }
  return hasAudioTrack;
}

function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && [[0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].some(([a, b]) => bytes[2] === a && bytes[3] === b);
}

async function readLimitedBody(response, limit) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error("file exceeds size limit");
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
      throw new Error("file exceeds size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function resolveFilePath(stateDir, relativePath) {
  const root = path.resolve(stateDir, "files");
  const target = path.resolve(stateDir, String(relativePath || ""));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("invalid stored file path");
  return target;
}

async function writeFileAtomically(absolutePath, bytes) {
  try {
    await fs.writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await fs.readFile(absolutePath);
    if (existing.length !== bytes.length || hashBytes(existing) !== hashBytes(bytes)) throw new Error("stored file path already contains different content");
  }
}

async function ensureStorageCapacity(stateDir, absolutePath, incomingBytes, maxStorageBytes = MAX_FILE_STORAGE_BYTES) {
  try {
    const existing = await fs.stat(absolutePath);
    if (existing.isFile()) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const root = path.resolve(stateDir, "files");
  let total = 0;
  for (const file of await listFiles(root)) {
    total += (await fs.stat(file)).size;
    if (total + incomingBytes > maxStorageBytes) throw new Error("file storage quota exceeded");
  }
}

async function listFiles(root) {
  const result = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.pop();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile()) result.push(target);
    }
  }
  return result;
}

async function removeEmptyDirectories(root) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(root, entry.name);
    await removeEmptyDirectories(child);
    try { await fs.rmdir(child); } catch (error) { if (!["ENOTEMPTY", "ENOENT"].includes(error?.code)) throw error; }
  }
}

function safeFileName(value) {
  const normalized = path.basename(String(value || "").replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return normalized.slice(0, 240);
}

function safeDay(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

function safeEventId(value) {
  return String(value || "event").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120) || "event";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function isAllowedHost(hostname, configuredHostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (normalized === String(configuredHostname || "").toLowerCase()) return true;
  return ALLOWED_DIRECT_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
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

function classifyFileError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("storage quota")) return "file_storage_full";
  if (message.includes("size limit") || message.includes("exceeds")) return "file_too_large";
  if (message.includes("unsupported file type")) return "unsupported_file_type";
  if (message.includes("decrypt")) return "file_decrypt_failed";
  if (message.includes("integrity") || message.includes("size mismatch") || message.includes("type mismatch") || message.includes("utf-8") || message.includes("ooxml") || message.includes("zip")) return "invalid_file";
  if (message.includes("http") || message.includes("download") || message.includes("timeout")) return "file_download_failed";
  return "file_store_failed";
}

function md5(bytes) {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

function hashBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export { DEFAULT_CDN_BASE_URL, FILE_TTL_MS, MAX_FILE_BYTES, MAX_FILES_PER_EVENT, MAX_FILE_STORAGE_BYTES };
