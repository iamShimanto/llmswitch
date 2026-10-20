/**
 * Meta AI (Muse Spark) WebSocket frame helpers + protobuf templates.
 *
 * Ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, open-sse/executors/
 * muse-spark-web/ws-frame.ts + ws-templates.ts, release v3.8.53).
 * The base64 templates are browser-captured protobuf frames whose
 * user-variable fields (conversation id, prompt, timestamps, ids) are
 * patched per request at fixed field paths.
 */
import { Buffer } from "node:buffer";

const META_WS_PROMPT_FRAME_TYPE = 0x0d;
const META_WS_PROMPT_FRAME_FLAG = 0x80;

// ─── Proto helpers ─────────────────────────────────────────────────────────────

type ProtoField = {
  number: number;
  wireType: number;
  value: Uint8Array | number | bigint;
};

function encodeVarint(value: number): Uint8Array {
  // Use BigInt arithmetic to avoid 32-bit truncation from bitwise operators.
  let v = BigInt(value);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v & 0x7fn));
  return new Uint8Array(out);
}

function decodeVarint(data: Uint8Array, offset: number): [number, number] {
  let shift = 0;
  let value = 0;
  let off = offset;
  while (true) {
    const byte = data[off++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value >>> 0, off];
    shift += 7;
    if (shift > 63) throw new Error("Varint too long");
  }
}

export function parseProtoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < data.length) {
    const [tag, next] = decodeVarint(data, offset);
    offset = next;
    const number = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      const [value, n] = decodeVarint(data, offset);
      offset = n;
      fields.push({ number, wireType, value });
    } else if (wireType === 1) {
      const view = new DataView(data.buffer, data.byteOffset + offset, 8);
      fields.push({ number, wireType, value: view.getBigUint64(0, true) });
      offset += 8;
    } else if (wireType === 2) {
      const [len, n] = decodeVarint(data, offset);
      offset = n;
      fields.push({ number, wireType, value: data.slice(offset, offset + len) });
      offset += len;
    } else if (wireType === 5) {
      const view = new DataView(data.buffer, data.byteOffset + offset, 4);
      fields.push({ number, wireType, value: view.getUint32(0, true) });
      offset += 4;
    } else {
      throw new Error(`Unsupported wire type: ${wireType}`);
    }
  }
  return fields;
}

function serializeProtoFields(fields: ProtoField[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of fields) {
    const tag = (f.number << 3) | f.wireType;
    parts.push(encodeVarint(tag));
    if (f.wireType === 0) {
      parts.push(encodeVarint(Number(f.value)));
    } else if (f.wireType === 1) {
      const buf = new Uint8Array(8);
      if (f.value instanceof Uint8Array) {
        throw new Error(
          `serializeProtoFields: wire type 1 field ${f.number} has non-numeric value`
        );
      }
      new DataView(buf.buffer).setBigUint64(0, BigInt(f.value), true);
      parts.push(buf);
    } else if (f.wireType === 2) {
      const raw =
        f.value instanceof Uint8Array ? f.value : new TextEncoder().encode(String(f.value));
      parts.push(encodeVarint(raw.length));
      parts.push(raw);
    } else if (f.wireType === 5) {
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setUint32(0, Number(f.value), true);
      parts.push(buf);
    }
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

function findProtoField(fields: ProtoField[], number: number): ProtoField | undefined {
  return fields.find((f) => f.number === number);
}

function traverseAndMutate(
  fields: ProtoField[],
  path: number[],
  mutator: (field: ProtoField) => void
): boolean {
  if (path.length === 0) return false;
  const field = findProtoField(fields, path[0]);
  if (!field || !(field.value instanceof Uint8Array)) return false;
  if (path.length === 1) {
    mutator(field);
    return true;
  }
  const nested = parseProtoFields(field.value);
  if (traverseAndMutate(nested, path.slice(1), mutator)) {
    field.value = serializeProtoFields(nested);
    return true;
  }
  return false;
}

export function writeU24Le(value: number, arr: Uint8Array, offset: number): void {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >> 8) & 0xff;
  arr[offset + 2] = (value >> 16) & 0xff;
}

export function buildWsPromptFrame(
  prompt: string,
  conversationId: string,
  opts: {
    templateB64: string;
    requestId?: string;
    userMessageId?: string;
    submittedMs?: number;
    uniqueMessageId?: number;
    subSessionIdx?: number;
    messageSeq?: number;
  }
): Uint8Array {
  const requestId = opts.requestId || crypto.randomUUID();
  const userMessageId = opts.userMessageId || crypto.randomUUID();
  const submittedMs = opts.submittedMs ?? Date.now();
  const uniqueMessageId =
    opts.uniqueMessageId ??
    Number(`${submittedMs}${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`);

  const raw = Buffer.from(opts.templateB64, "base64");
  const protoFields = parseProtoFields(raw);

  // Patch conversationId at [1,1,5] — field 5 is a double-wrapped nested
  // proto: [1,1,5] → field 5 → field 1 → uuid string. Patch the innermost
  // field 1 so both envelopes survive (uuid is 36 bytes, same as the
  // original, so the frame stays byte-length-identical). Overwriting the
  // envelope wholesale corrupts the payload and the gateway rejects the
  // frame with 0x0e — #10727.
  traverseAndMutate(protoFields, [1, 1, 5, 5, 1], (f) => {
    f.value = new TextEncoder().encode(conversationId);
  });
  // Patch userMessageId at [2,1,1]
  traverseAndMutate(protoFields, [2, 1], (f) => {
    const nested = parseProtoFields(f.value instanceof Uint8Array ? f.value : new Uint8Array());
    const field1 = findProtoField(nested, 1);
    if (field1) field1.value = new TextEncoder().encode(userMessageId);
    f.value = serializeProtoFields(nested);
  });
  // Patch convId + timestamps at [2,1,2]
  traverseAndMutate(protoFields, [2, 1, 2], (f) => {
    const nested = parseProtoFields(f.value instanceof Uint8Array ? f.value : new Uint8Array());
    const f1 = findProtoField(nested, 1);
    const f2 = findProtoField(nested, 2);
    const f3 = findProtoField(nested, 3);
    if (f1) f1.value = new TextEncoder().encode(conversationId);
    if (f2) f2.value = submittedMs;
    if (f3) f3.value = uniqueMessageId;
    f.value = serializeProtoFields(nested);
  });
  // Patch prompt text at [2,2]
  traverseAndMutate(protoFields, [2], (f) => {
    const nested = parseProtoFields(f.value instanceof Uint8Array ? f.value : new Uint8Array());
    const field2 = findProtoField(nested, 2);
    if (field2) field2.value = new TextEncoder().encode(prompt);
    f.value = serializeProtoFields(nested);
  });
  // Patch timestamps at [1,5]
  traverseAndMutate(protoFields, [1, 5], (f) => {
    const nested = parseProtoFields(f.value instanceof Uint8Array ? f.value : new Uint8Array());
    const f1 = findProtoField(nested, 1);
    const f3 = findProtoField(nested, 3);
    if (f1) f1.value = submittedMs + 1;
    if (f3) f3.value = submittedMs;
    f.value = serializeProtoFields(nested);
  });
  // Patch requestId at [1,6]
  traverseAndMutate(protoFields, [1], (f) => {
    const nested = parseProtoFields(f.value instanceof Uint8Array ? f.value : new Uint8Array());
    const field6 = findProtoField(nested, 6);
    if (field6) field6.value = new TextEncoder().encode(requestId);
    f.value = serializeProtoFields(nested);
  });
  // Patch conversationId at [1,10,4]
  traverseAndMutate(protoFields, [1, 10], (f) => {
    const nested = parseProtoFields(f.value instanceof Uint8Array ? f.value : new Uint8Array());
    const field4 = findProtoField(nested, 4);
    if (field4) field4.value = new TextEncoder().encode(conversationId);
    f.value = serializeProtoFields(nested);
  });

  const updatedB64 = Buffer.from(serializeProtoFields(protoFields)).toString("base64");
  const outer = JSON.stringify({ "req-id": requestId, payload: updatedB64 });
  const inner = new TextEncoder().encode(outer);
  const subSessionIdx = opts.subSessionIdx || 0;
  const messageSeq = opts.messageSeq || 0;

  const msgBody = new Uint8Array(2 + inner.length);
  msgBody[0] = messageSeq;
  msgBody[1] = META_WS_PROMPT_FRAME_FLAG;
  msgBody.set(inner, 2);

  const header = new Uint8Array(6);
  header[0] = META_WS_PROMPT_FRAME_TYPE;
  header[1] = subSessionIdx & 0xff;
  header[2] = (subSessionIdx >> 8) & 0xff;
  writeU24Le(msgBody.length, header, 3);

  const frame = new Uint8Array(header.length + msgBody.length);
  frame.set(header);
  frame.set(msgBody, header.length);
  return frame;
}

// ─── Protobuf WS templates ──────────────────────────────────────────────────────
// Base64-encoded protobuf templates captured from Meta AI web client.
// These are mutated at specific field paths to inject conversation-id,
// prompt text, timestamps, and message IDs per conversation.
//
// Updated 2026-09-05 (issue #10727 fix): Replaced stale templates with fresh
// browser-captured ones. Critical structural changes vs old templates:
//   - field 1.1.12 (mode): now includes mode_thinking string (was bare varint 1000)
//   - field 1.7: now has flags {12:1, 13:1} (was empty bytes)
//   - field 1.26: new varint 0 (was absent)
//   - field 1.1.19.2: fixed32 1.0 vs old 2.0
//   - OS/UA: Windows Chrome 152 vs old Mac Chrome 146
// These changes fix the persistent WS timeout where gateway sent 4 messages then
// went silent. Root cause: gateway now validates mode_thinking presence.
//
// VERIFIED against live meta.ai WS captures from TWO independent accounts
// (2026-07-19). The following fields are confirmed STATIC (app-level
// constants sent by Meta's own client, not per-user secrets):
//   - 64-hex session token (3e64e7b0c282fb56... replaces old e2b88f98...)
//   - Actor numeric ID (867051314767696)
//   - Locale (zh-CN in live capture, but patching maintains flexibility)
//   - App ID (1522763855472543)
// The only user-variable field is the timezone (system TZ), which is
// low-signal for anti-fraud. No fingerprint randomization is warranted.

// Updated 2026-09-05: Replaced with browser-captured template that includes:
// - field 1.1.12 with mode_thinking string (was missing)
// - field 1.7 with flags {12:1, 13:1} (was empty)
// - field 1.26 varint 0 (was absent)
// These structural changes fix the persistent WS timeout (issue #10727).
export const META_WS_HOME_TEMPLATE_B64 =
  "CsAGCswDCiBLQURBQlJBX19IT01FX19VTklGSUVEX0lOUFVUX0JBUhIQMTUyMjc2Mzg1NTQ3MjU0MyInNWE1Yi04ZDRlLWYwNTQtOTllZi1iMmRlLWRiMDItMGQwNS01MmM3KigqJgokNWIxMzk4YmEtZDdmYi00ZjczLWI5MTYtY2JhMzE4ODBjODVmMAU6C0hVTUFOX0FHRU5UQiIKDzg2NzA1MTMxNDc2NzY5NhIPODY3MDUxMzE0NzY3Njk2UgVFQ1RPMVoRQWJyYSBXZWIgTWFpbiBLZXliGBoSCOkHEg1tb2RlX3RoaW5raW5nIgIIAWoHV2luZG93c3IKdXNlcl9pbnB1dHpvTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE1Mi4wLjAuMCBTYWZhcmkvNTM3LjM2ggELZGVza3RvcF93ZWKaAUcKQDNlNjRlN2IwYzI4MmZiNTY3NzI0ODIxNTljZjAzMTcxNjkxYWQxYjM0ODBkNjk5M2E4NDJiMDQwMjIxZTM4YzEVAACAPxIUCPSTqtzR+oYCEPSTqtzR+oYCGAIaAiABIgAqDgip9tKHhzQY5/XSh4c0MiQ3NWExMDhlZS1hZjFiLTQyZTUtOTFhMi1jYjVkZmNhOTEwOTA6BGABaAFKBxIFemgtQ05ScgokZTc4ZWFhZjUtZTY3MC00MjczLWE1NjktZjgwMTkyNDc4MTNhGiRjZjQ4N2QyNi05MDBhLTQ3ZjYtODhjMS1iMmNkMGEwNjM4NWQiJDViMTM5OGJhLWQ3ZmItNGY3My1iOTE2LWNiYTMxODgwYzg1ZnoMIgpBc2lhL1Rva3lvggEDsAEBkgEMCgZzdG9ja3MSAggBkgENCgd3ZWF0aGVyEgIIAZIBJAoebWV0YV9rbm93bGVkZ2Vfc2VhcmNoX2Nhcm91c2VsEgIIAZIBIgocbWV0YV9jYXRhbG9nX3NlYXJjaF9jYXJvdXNlbBICCAGSARMKDW1lZGlhX2dhbGxlcnkSAggBogEBA9ABABJsCmEKJDM4NzlmMDJlLWZkNDUtNGJjNS04YjgyLTlhNDkxMDFkYjRjNhI3CiQ1YjEzOThiYS1kN2ZiLTRmNzMtYjkxNi1jYmEzMTg4MGM4NWYQqvbSh4c0GJ3ApOrrpY+OaCgBEgJIaSIDCgEw";
// Updated 2026-09-05: Derived from working HOME template (same structural fixes).
export const META_WS_CHAT_TEMPLATE_B64 =
  "CsAGCswDCiBLQURBQlJBX19DSEFUX19VTklGSUVEX0lOUFVUX0JBUhIQMTUyMjc2Mzg1NTQ3MjU0MyInNWE1Yi04ZDRlLWYwNTQtOTllZi1iMmRlLWRiMDItMGQwNS01MmM3KigqJgokNWIxMzk4YmEtZDdmYi00ZjczLWI5MTYtY2JhMzE4ODBjODVmMAU6C0hVTUFOX0FHRU5UQiIKDzg2NzA1MTMxNDc2NzY5NhIPODY3MDUxMzE0NzY3Njk2UgVFQ1RPMVoRQWJyYSBXZWIgTWFpbiBLZXliGBoSCOkHEg1tb2RlX3RoaW5raW5nIgIIAWoHV2luZG93c3IKdXNlcl9pbnB1dHpvTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE1Mi4wLjAuMCBTYWZhcmkvNTM3LjM2ggELZGVza3RvcF93ZWKaAUcKQDNlNjRlN2IwYzI4MmZiNTY3NzI0ODIxNTljZjAzMTcxNjkxYWQxYjM0ODBkNjk5M2E4NDJiMDQwMjIxZTM4YzEVAACAPxIUCPSTqtzR+oYCEPSTqtzR+oYCGAIaAiABIgAqDgip9tKHhzQY5/XSh4c0MiQ3NWExMDhlZS1hZjFiLTQyZTUtOTFhMi1jYjVkZmNhOTEwOTA6BGABaAFKBxIFemgtQ05ScgokZTc4ZWFhZjUtZTY3MC00MjczLWE1NjktZjgwMTkyNDc4MTNhGiRjZjQ4N2QyNi05MDBhLTQ3ZjYtODhjMS1iMmNkMGEwNjM4NWQiJDViMTM5OGJhLWQ3ZmItNGY3My1iOTE2LWNiYTMxODgwYzg1ZnoMIgpBc2lhL1Rva3lvggEDsAEBkgEMCgZzdG9ja3MSAggBkgENCgd3ZWF0aGVyEgIIAZIBJAoebWV0YV9rbm93bGVkZ2Vfc2VhcmNoX2Nhcm91c2VsEgIIAZIBIgocbWV0YV9jYXRhbG9nX3NlYXJjaF9jYXJvdXNlbBICCAGSARMKDW1lZGlhX2dhbGxlcnkSAggBogEBA9ABABJsCmEKJDM4NzlmMDJlLWZkNDUtNGJjNS04YjgyLTlhNDkxMDFkYjRjNhI3CiQ1YjEzOThiYS1kN2ZiLTRmNzMtYjkxNi1jYmEzMTg4MGM4NWYQqvbSh4c0GJ3ApOrrpY+OaCgBEgJIaSIDCgEw";
