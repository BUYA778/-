import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type PhotoMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface PhotoSummary {
  id: string;
  savedAt: string;
  mediaType: PhotoMediaType;
  bytes: number;
  description: string;
  tags: string[];
}

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

export function detectImageMediaType(bytes: Uint8Array): PhotoMediaType | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

export function createPhotoAlbum(dbFile: string) {
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      saved_at TEXT NOT NULL,
      media_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      description TEXT NOT NULL,
      tags TEXT NOT NULL,
      data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_photo_time ON photos(saved_at DESC);
  `);

  function savePhoto(data: Uint8Array, description: string, tags: readonly string[] = []): PhotoSummary {
    const mediaType = detectImageMediaType(data);
    if (!mediaType) throw new Error('仅支持 png、jpg、webp、gif 真实图片格式');
    if (data.byteLength < 1 || data.byteLength > MAX_PHOTO_BYTES) {
      throw new Error('图片大小必须在 1B 到 20MB 之间');
    }
    const cleanDesc = String(description ?? '').trim();
    if (!cleanDesc || Array.from(cleanDesc).length > 500) {
      throw new Error('照片说明必填且不超过 500 字');
    }
    const cleanTags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 8);
    const id = `photo_${createHash('sha256').update(data).digest('hex').slice(0, 16)}`;
    const savedAt = new Date().toISOString();

    db.prepare(
      'INSERT OR REPLACE INTO photos (id, saved_at, media_type, bytes, description, tags, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, savedAt, mediaType, data.byteLength, cleanDesc, JSON.stringify(cleanTags), data);

    return { id, savedAt, mediaType, bytes: data.byteLength, description: cleanDesc, tags: cleanTags };
  }

  function listPhotos(tag?: string, limit = 20): PhotoSummary[] {
    const rows = db.prepare(
      'SELECT id, saved_at, media_type, bytes, description, tags FROM photos ORDER BY saved_at DESC LIMIT ?',
    ).all(Math.max(1, Math.min(100, limit))) as Array<{
      id: string;
      saved_at: string;
      media_type: PhotoMediaType;
      bytes: number;
      description: string;
      tags: string;
    }>;

    return rows
      .map((r) => ({
        id: r.id,
        savedAt: r.saved_at,
        mediaType: r.media_type,
        bytes: r.bytes,
        description: r.description,
        tags: JSON.parse(r.tags) as string[],
      }))
      .filter((item) => !tag || item.tags.includes(tag));
  }

  function close(): void {
    db.close();
  }

  return { savePhoto, listPhotos, close };
}
