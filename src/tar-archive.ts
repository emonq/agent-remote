import path from 'node:path';
import zlib from 'node:zlib';

export interface TarEntry {
  path: string;
  content: string | Buffer;
  mode?: number;
}

const tarBlockSize = 512;

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value);
  if (encoded.length > length) throw new Error(`tar 字段过长: ${value}`);
  encoded.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = Math.max(0, Math.floor(value)).toString(8);
  if (encoded.length > length - 1) throw new Error(`tar 数值过大: ${value}`);
  buffer.write(encoded.padStart(length - 1, '0'), offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function tarHeader(name: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(tarBlockSize);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'agent-remote');
  writeString(header, 297, 32, 'agent-remote');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function safeArchivePath(value: unknown): string {
  const relativePath = String(value || '');
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').includes('..')) {
    throw new Error(`压缩包包含不安全路径: ${relativePath}`);
  }
  return relativePath;
}

export function createTarGzip(entries: TarEntry[]): Buffer {
  if (!entries.length) throw new Error('压缩包不能为空');
  const names = new Set<string>();
  const archive: Buffer[] = [];
  for (const entry of entries) {
    const relativePath = safeArchivePath(entry.path);
    if (names.has(relativePath)) throw new Error(`压缩包包含重复路径: ${relativePath}`);
    names.add(relativePath);
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    archive.push(tarHeader(relativePath, content.length, entry.mode ?? 0o644));
    archive.push(content);
    const padding = (tarBlockSize - (content.length % tarBlockSize)) % tarBlockSize;
    if (padding) archive.push(Buffer.alloc(padding));
  }
  archive.push(Buffer.alloc(tarBlockSize * 2));
  return zlib.gzipSync(Buffer.concat(archive), { level: 9 });
}
