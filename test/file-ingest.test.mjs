import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import test from "node:test";
import { createMcpApp } from "../src/mcp-app.mjs";
import { persistInboundFiles, pruneOrphanedFiles } from "../src/file-store.mjs";
import { StateStore } from "../src/state-store.mjs";
import { WeChatTransport } from "../src/transport.mjs";

function fixture(options = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wwit-file-"));
  const store = new StateStore({ stateDir });
  const transport = new WeChatTransport({
    store,
    ilinkClient: { async sendText() { return { ret: 0 }; } },
    mode: "simulation",
    channelId: "wechat",
    now: options.now || (() => new Date("2026-10-27T00:00:00.000Z")),
    mediaFetchFn: options.mediaFetchFn || fetch,
    serialEventDispatchEnabled: false,
  });
  return { stateDir, store, transport, cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }) };
}

function inbound(overrides = {}) {
  return {
    from_user_id: "wx-user-1",
    message_id: "message-1",
    client_id: "client-1",
    message_type: 1,
    create_time_ms: Date.parse("2026-10-27T00:00:00.000Z"),
    context_token: "context-1",
    item_list: [{ type: 1, text_item: { text: "你好" } }],
    ...overrides,
  };
}

function zipFixture(entries, { deflate = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(value);
    const payload = deflate ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("encrypted supported files are persisted and returned as MCP resources", async (t) => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "utf8");
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(pdf), cipher.final()]);
  const f = fixture({ mediaFetchFn: async () => new Response(encrypted, { status: 200 }) });
  t.after(f.cleanup);
  const app = createMcpApp({ store: f.store, transport: f.transport });
  const event = await f.transport.acceptRawMessage(inbound({
    item_list: [{
      type: 4,
      file_item: {
        file_name: "lesson.pdf",
        len: String(pdf.length),
        md5: crypto.createHash("md5").update(pdf).digest("hex"),
        media: { full_url: "https://example.qpic.cn/document", aes_key: Buffer.from(key.toString("hex"), "utf8").toString("base64") },
      },
    }],
  }), { accountId: "simulation-account" });
  assert.equal(event.data.text, "[文件]");
  assert.equal(event.data.message_type, "file");
  assert.equal(event.data.file_count, 1);
  assert.equal(event.data.file_error_count, 0);
  assert.equal("files" in event.data, false);
  const result = await app.handleRpc("tools/call", {
    name: "get_wechat_file",
    arguments: { event_id: event.eventId, file_index: 0 },
  }, { scopes: ["wechat:read"] });
  assert.equal(result.structuredContent.mime_type, "application/pdf");
  assert.equal(result.structuredContent.extraction_status, "unavailable");
  assert.equal(result.content[1].type, "resource");
  assert.deepEqual(Buffer.from(result.content[1].resource.blob, "base64"), pdf);
});

test("PPTX extraction preserves slide order and OMML delimiters", async (t) => {
  const pptx = zipFixture({
    "[Content_Types].xml": '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
    "ppt/presentation.xml": "<p:presentation></p:presentation>",
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>幂函数</a:t></a:r><m:d><m:dPr><m:begChr m:val=\"[\"/><m:endChr m:val=\"]\"/></m:dPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:d></a:p></p:sld>",
  });
  const f = fixture({ mediaFetchFn: async () => new Response(pptx, { status: 200 }) });
  t.after(f.cleanup);
  const app = createMcpApp({ store: f.store, transport: f.transport });
  const event = await f.transport.acceptRawMessage(inbound({
    item_list: [{ type: 4, file_item: { file_name: "lesson.pptx", len: String(pptx.length), media: { full_url: "https://example.qpic.cn/presentation" } } }],
  }), { accountId: "simulation-account" });
  const result = await app.handleRpc("tools/call", {
    name: "get_wechat_file",
    arguments: { event_id: event.eventId, file_index: 0 },
  }, { scopes: ["wechat:read"] });
  const extracted = result.content.find((item) => item.type === "text" && item.text.includes("[第1页]"))?.text || "";
  assert.match(extracted, /\[第1页\][\s\S]*幂函数\[x\][\s\S]*\[第2页\][\s\S]*第二页/);
});

test("XLSX extraction preserves rich-text shared-string indices", async (t) => {
  const xlsx = zipFixture({
    "[Content_Types].xml": '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    "xl/workbook.xml": "<workbook></workbook>",
    "xl/sharedStrings.xml": "<sst><si><r><t>富</t></r><r><t>文本</t></r></si><si><t>下一项</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>',
  });
  const f = fixture({ mediaFetchFn: async () => new Response(xlsx, { status: 200 }) });
  t.after(f.cleanup);
  const app = createMcpApp({ store: f.store, transport: f.transport });
  const event = await f.transport.acceptRawMessage(inbound({
    item_list: [{ type: 4, file_item: { file_name: "table.xlsx", len: String(xlsx.length), media: { full_url: "https://example.qpic.cn/workbook" } } }],
  }), { accountId: "simulation-account" });
  const result = await app.handleRpc("tools/call", {
    name: "get_wechat_file",
    arguments: { event_id: event.eventId, file_index: 0 },
  }, { scopes: ["wechat:read"] });
  const extracted = result.content.find((item) => item.type === "text" && item.text.includes("富文本"))?.text || "";
  assert.match(extracted, /富文本\t下一项/);
});

test("unsupported files produce explicit attachment errors", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const event = await f.transport.acceptRawMessage(inbound({
    item_list: [{ type: 4, file_item: { file_name: "program.exe", media: { full_url: "https://example.qpic.cn/file" } } }],
  }), { accountId: "simulation-account" });
  assert.equal(event.data.text, "[文件]");
  assert.equal(event.data.file_count, 0);
  assert.equal(event.data.file_error_count, 1);
  assert.equal(f.store.state.inboundEvents[0].internal.fileErrors[0].code, "unsupported_file_type");
});

test("file retention removes orphans and expires old references", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const root = path.join(f.stateDir, "files", "2026-09-01");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "keep.txt"), "keep");
  fs.writeFileSync(path.join(root, "orphan.txt"), "remove");
  let result = await pruneOrphanedFiles({ stateDir: f.stateDir, retainedRelativePaths: ["files/2026-09-01/keep.txt"] });
  assert.equal(result.removedFiles, 1);
  result = await pruneOrphanedFiles({
    stateDir: f.stateDir,
    retainedFiles: [{ relativePath: "files/2026-09-01/keep.txt", receivedAt: "2026-09-01T00:00:00.000Z" }],
    now: new Date("2026-10-02T00:00:00.000Z"),
  });
  assert.equal(result.removedFiles, 1);
});

test("expired files are pruned before enforcing the storage quota", async (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const expiredPath = path.join(f.stateDir, "files", "2026-09-01", "expired.txt");
  fs.mkdirSync(path.dirname(expiredPath), { recursive: true });
  fs.writeFileSync(expiredPath, "expired data");
  const text = Buffer.from("new", "utf8");
  const result = await persistInboundFiles({
    fileRefs: [{ fileName: "new.txt", directUrls: ["https://example.qpic.cn/file"] }],
    stateDir: f.stateDir,
    eventId: "new-event",
    receivedAt: "2026-10-02T00:00:00.000Z",
    fetchFn: async () => new Response(text, { status: 200 }),
    retainedFiles: [{ relativePath: "files/2026-09-01/expired.txt", receivedAt: "2026-09-01T00:00:00.000Z" }],
    now: new Date("2026-10-02T00:00:00.000Z"),
    maxStorageBytes: 8,
  });
  assert.equal(result.files.length, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(fs.existsSync(expiredPath), false);
});

test("concurrent attachment ingestion is serialized across pruning and commit", async (t) => {
  let activeFetches = 0;
  let maximumActiveFetches = 0;
  const f = fixture({
    mediaFetchFn: async () => {
      activeFetches += 1;
      maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeFetches -= 1;
      return new Response(Buffer.from("attachment", "utf8"), { status: 200 });
    },
  });
  t.after(f.cleanup);
  const [first, second] = await Promise.all([
    f.transport.acceptRawMessage(inbound({
      message_id: "concurrent-1",
      client_id: "concurrent-client-1",
      item_list: [{ type: 4, file_item: { file_name: "first.txt", media: { full_url: "https://example.qpic.cn/first" } } }],
    }), { accountId: "simulation-account" }),
    f.transport.acceptRawMessage(inbound({
      message_id: "concurrent-2",
      client_id: "concurrent-client-2",
      item_list: [{ type: 4, file_item: { file_name: "second.txt", media: { full_url: "https://example.qpic.cn/second" } } }],
    }), { accountId: "simulation-account" }),
  ]);
  assert.equal(maximumActiveFetches, 1);
  assert.equal(first.data.file_count, 1);
  assert.equal(second.data.file_count, 1);
  for (const event of f.store.state.inboundEvents) {
    assert.equal(fs.existsSync(path.join(f.stateDir, event.internal.files[0].relativePath)), true);
  }
});

for (const scenario of [
  {
    name: "unsafe OOXML paths",
    fileName: "unsafe.pptx",
    bytes: () => zipFixture({ "[Content_Types].xml": '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>', "ppt/presentation.xml": "<p:presentation/>", "../ppt/slides/slide1.xml": "<a:t>unsafe</a:t>" }),
    expectedCode: "invalid_file",
  },
  {
    name: "compressed OOXML zip bombs",
    fileName: "bomb.pptx",
    bytes: () => zipFixture({ "[Content_Types].xml": '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>', "ppt/presentation.xml": "<p:presentation/>", "ppt/slides/slide1.xml": Buffer.alloc(20 * 1024 * 1024 + 1, 0x41) }, { deflate: true }),
    expectedCode: "invalid_file",
  },
  {
    name: "forged supported extensions",
    fileName: "forged.pptx",
    bytes: () => Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"),
    expectedCode: "invalid_file",
  },
  {
    name: "renamed OOXML packages",
    fileName: "renamed.pptx",
    bytes: () => zipFixture({
      "[Content_Types].xml": '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "word/document.xml": "<w:document><w:t>not a presentation</w:t></w:document>",
    }),
    expectedCode: "invalid_file",
  },
  {
    name: "renamed RIFF video files",
    fileName: "video.wav",
    bytes: () => Buffer.from("RIFF0000AVI LIST", "ascii"),
    expectedCode: "invalid_file",
  },
  {
    name: "renamed MP4 video files",
    fileName: "video.m4a",
    bytes: () => mp4Fixture("vide"),
    expectedCode: "invalid_file",
  },
  {
    name: "damaged AES ciphertext",
    fileName: "damaged.pdf",
    bytes: () => crypto.randomBytes(32),
    aesKey: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
    expectedCode: "file_decrypt_failed",
  },
]) {
  test(`${scenario.name} are rejected without suppressing the event`, async (t) => {
    const bytes = scenario.bytes();
    if (scenario.name.includes("zip bombs")) assert.ok(bytes.length < 100_000);
    const f = fixture({ mediaFetchFn: async () => new Response(bytes, { status: 200 }) });
    t.after(f.cleanup);
    const event = await f.transport.acceptRawMessage(inbound({
      item_list: [{
        type: 4,
        file_item: {
          file_name: scenario.fileName,
          media: {
            full_url: "https://example.qpic.cn/file",
            ...(scenario.aesKey ? { aes_key: Buffer.from(scenario.aesKey.toString("hex"), "utf8").toString("base64") } : {}),
          },
        },
      }],
    }), { accountId: "simulation-account" });
    assert.equal(event.data.file_count, 0);
    assert.equal(event.data.file_error_count, 1);
    assert.equal(f.store.state.inboundEvents[0].internal.fileErrors[0].code, scenario.expectedCode);
  });
}

function mp4Fixture(handlerType) {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write("ftyp", 4, "ascii");
  ftyp.write("M4A ", 8, "ascii");
  const moov = Buffer.alloc(32);
  moov.writeUInt32BE(32, 0);
  moov.write("moov", 4, "ascii");
  moov.writeUInt32BE(24, 8);
  moov.write("hdlr", 12, "ascii");
  moov.write(handlerType, 24, "ascii");
  return Buffer.concat([ftyp, moov]);
}
