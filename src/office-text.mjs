import yauzl from "yauzl";

const MAX_ZIP_ENTRIES = 2_000;
const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS = 200_000;

export async function inspectOfficeFile(bytes, extension) {
  const entries = await readZipEntries(bytes, wantedEntries(extension));
  if (!entries.has("[Content_Types].xml")) throw new Error("OOXML package is missing [Content_Types].xml");
  validatePackageType(entries, extension);
  let text = "";
  if (extension === ".docx") text = extractWord(entries.get("word/document.xml") || "");
  else if (extension === ".pptx") text = extractPowerPoint(entries);
  else if (extension === ".xlsx") text = extractSpreadsheet(entries);
  else throw new Error("unsupported OOXML type");
  return truncateText(text);
}

function wantedEntries(extension) {
  if (extension === ".docx") return (name) => name === "[Content_Types].xml" || name === "word/document.xml";
  if (extension === ".pptx") return (name) => name === "[Content_Types].xml" || name === "ppt/presentation.xml" || /^ppt\/slides\/slide\d+\.xml$/i.test(name);
  if (extension === ".xlsx") {
    return (name) => name === "[Content_Types].xml" || name === "xl/workbook.xml" || name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/i.test(name);
  }
  return (name) => name === "[Content_Types].xml";
}

function validatePackageType(entries, extension) {
  const expected = {
    ".docx": {
      mainPart: "word/document.xml",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    },
    ".pptx": {
      mainPart: "ppt/presentation.xml",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    },
    ".xlsx": {
      mainPart: "xl/workbook.xml",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    },
  }[extension];
  if (!expected) throw new Error("unsupported OOXML type");
  const contentTypes = entries.get("[Content_Types].xml") || "";
  if (!entries.has(expected.mainPart) || !contentTypes.includes(expected.contentType)) {
    throw new Error("OOXML package type does not match the file extension");
  }
}

function readZipEntries(bytes, wanted) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (openError, zip) => {
      if (openError) return reject(new Error("invalid OOXML zip"));
      const result = new Map();
      const seen = new Set();
      let entryCount = 0;
      let totalUncompressed = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch {}
        reject(error);
      };
      zip.on("error", () => fail(new Error("invalid OOXML zip")));
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(result);
      });
      zip.on("entry", (entry) => {
        try {
          entryCount += 1;
          if (entryCount > MAX_ZIP_ENTRIES) throw new Error("OOXML zip has too many entries");
          const name = String(entry.fileName || "");
          validateEntryName(name);
          if (seen.has(name)) throw new Error("OOXML zip contains duplicate entries");
          seen.add(name);
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new Error("encrypted OOXML entries are unsupported");
          if (isSymlink(entry)) throw new Error("OOXML zip contains a symbolic link");
          if (!name.endsWith("/")) {
            if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw new Error("OOXML zip entry is too large");
            totalUncompressed += entry.uncompressedSize;
            if (totalUncompressed > MAX_ZIP_TOTAL_BYTES) throw new Error("OOXML zip expands beyond the limit");
          }
          if (!wanted(name) || name.endsWith("/")) return zip.readEntry();
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(new Error("OOXML zip entry could not be read"));
            const chunks = [];
            let total = 0;
            stream.on("data", (chunk) => {
              total += chunk.length;
              if (total > MAX_ZIP_ENTRY_BYTES) {
                stream.destroy(new Error("OOXML zip entry is too large"));
                return;
              }
              chunks.push(chunk);
            });
            stream.on("error", (error) => fail(error.message.includes("too large") ? error : new Error("OOXML zip entry could not be read")));
            stream.on("end", () => {
              if (settled) return;
              result.set(name, Buffer.concat(chunks, total).toString("utf8"));
              zip.readEntry();
            });
          });
        } catch (error) {
          fail(error);
        }
      });
      zip.readEntry();
    });
  });
}

function validateEntryName(name) {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error("OOXML zip contains an unsafe path");
  }
  const parts = name.split("/");
  if (parts.some((part) => part === ".." || part === ".")) throw new Error("OOXML zip contains an unsafe path");
}

function isSymlink(entry) {
  const unixMode = (Number(entry.externalFileAttributes) >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

function extractWord(xml) {
  if (!xml) return "";
  return extractTextTokens(xml, {
    textTags: new Set(["w:t", "m:t"]),
    newlineTags: new Set(["w:p", "w:br"]),
    tabTags: new Set(["w:tab"]),
  });
}

function extractPowerPoint(entries) {
  return [...entries.entries()]
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(([left], [right]) => slideNumber(left) - slideNumber(right))
    .map(([name, xml]) => {
      const number = slideNumber(name);
      const body = extractTextTokens(xml, {
        textTags: new Set(["a:t", "m:t"]),
        newlineTags: new Set(["a:p", "a:br"]),
        tabTags: new Set(),
      });
      return body ? `[第${number}页]\n${body}` : `[第${number}页]`;
    })
    .join("\n\n");
}

function extractSpreadsheet(entries) {
  const shared = extractSharedStrings(entries.get("xl/sharedStrings.xml") || "");
  return [...entries.entries()]
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(([left], [right]) => sheetNumber(left) - sheetNumber(right))
    .map(([name, xml]) => `[工作表${sheetNumber(name)}]\n${extractWorksheet(xml, shared)}`.trim())
    .join("\n\n");
}

function extractSharedStrings(xml) {
  const result = [];
  for (const match of String(xml || "").matchAll(/<(?:[A-Za-z0-9_.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?si>/gi)) {
    result.push(extractXmlTexts(match[1], new Set(["t"])).join(""));
  }
  return result;
}

function extractWorksheet(xml, shared) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const inline = extractXmlTexts(body, new Set(["t"])).join("");
      const raw = firstXmlValue(body, "v");
      const value = /\bt=["']s["']/i.test(attrs) && /^\d+$/.test(raw) ? (shared[Number(raw)] || "") : (inline || raw);
      cells.push(value);
    }
    rows.push(cells.join("\t").replace(/\t+$/g, ""));
  }
  return rows.join("\n").trim();
}

function extractTextTokens(xml, { textTags, newlineTags, tabTags }) {
  xml = expandMathDelimiters(xml);
  const tokens = [];
  const pattern = /<\/?([A-Za-z0-9_:.-]+)\b[^>]*>|([^<]+)/g;
  for (const match of xml.matchAll(pattern)) {
    if (match[2] !== undefined) continue;
    const raw = match[0];
    const tag = match[1];
    const closing = raw.startsWith("</");
    if (textTags.has(tag) && !closing) {
      const end = xml.indexOf(`</${tag}>`, match.index + raw.length);
      if (end >= 0) tokens.push(decodeXml(xml.slice(match.index + raw.length, end)));
    } else if (newlineTags.has(tag) && (closing || raw.endsWith("/>"))) tokens.push("\n");
    else if (tabTags.has(tag) && !closing) tokens.push("\t");
  }
  return normalizeExtractedText(tokens.join(""));
}

function expandMathDelimiters(xml) {
  let value = String(xml || "");
  for (let round = 0; round < 20 && /<m:d\b/i.test(value); round += 1) {
    const next = value.replace(/<m:d\b[^>]*>([\s\S]*?)<\/m:d>/gi, (_, body) => {
      const properties = body.match(/<m:dPr\b[^>]*>([\s\S]*?)<\/m:dPr>/i)?.[1] || "";
      const begin = decodeXml(properties.match(/<m:begChr\b[^>]*m:val=["']([^"']*)["'][^>]*\/?\s*>/i)?.[1] ?? "(");
      const end = decodeXml(properties.match(/<m:endChr\b[^>]*m:val=["']([^"']*)["'][^>]*\/?\s*>/i)?.[1] ?? ")");
      const content = body.replace(/<m:dPr\b[^>]*>[\s\S]*?<\/m:dPr>/i, "");
      return `<m:t>${escapeXml(begin)}</m:t>${content}<m:t>${escapeXml(end)}</m:t>`;
    });
    if (next === value) break;
    value = next;
  }
  return value;
}

function extractXmlTexts(xml, localNames) {
  const result = [];
  for (const local of localNames) {
    const pattern = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${local}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?${local}>`, "gi");
    for (const match of xml.matchAll(pattern)) result.push(decodeXml(match[1].replace(/<[^>]+>/g, "")));
  }
  return result;
}

function firstXmlValue(xml, localName) {
  const pattern = new RegExp(`<([A-Za-z0-9_.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/([A-Za-z0-9_.-]+:)?${localName}>`, "i");
  const match = xml.match(pattern);
  return match ? decodeXml(match[2].replace(/<[^>]+>/g, "")).trim() : "";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function escapeXml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeExtractedText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(value) {
  const normalized = normalizeExtractedText(value);
  return {
    text: normalized.slice(0, MAX_EXTRACTED_TEXT_CHARS),
    characterCount: normalized.length,
    truncated: normalized.length > MAX_EXTRACTED_TEXT_CHARS,
  };
}

function slideNumber(name) {
  return Number(name.match(/slide(\d+)\.xml$/i)?.[1] || 0);
}

function sheetNumber(name) {
  return Number(name.match(/sheet(\d+)\.xml$/i)?.[1] || 0);
}

export { MAX_EXTRACTED_TEXT_CHARS, MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES };
