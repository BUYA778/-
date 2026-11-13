import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listDiaryDates, readDiaryEntry } from './diary.js';

export interface ArchiveRecord {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  content: string;
  occurredAt: string;
}

export interface MemoryHit {
  ref: string;
  kind: 'conversation' | 'diary';
  time: string;
  who: string;
  excerpt: string;
  turnId?: string;
}

const EXCERPT_CHARS = 200;
const READ_LIMIT_CHARS = 2000;

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

export function createArchiveStore(dbFile: string, diaryDir: string) {
  mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_time ON conversations(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conv_turn ON conversations(turn_id);
  `);

  function appendMessage(turnId: string, role: 'user' | 'assistant', content: string, occurredAt: string): string {
    const clean = String(content ?? '').trim();
    const id = createHash('sha256').update(`${turnId}:${role}:${occurredAt}:${clean}`).digest('hex').slice(0, 24);
    db.prepare('INSERT OR IGNORE INTO conversations (id, turn_id, role, content, occurred_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      turnId,
      role,
      clean,
      occurredAt,
    );
    return id;
  }

  function find(params: { query?: string; kind?: 'all' | 'conversation' | 'diary'; limit?: number; turnId?: string }): MemoryHit[] {
    const limit = Math.max(1, Math.min(20, Number(params.limit) || 8));
    const query = String(params.query ?? '').trim().toLowerCase();
    const kind = params.kind ?? 'all';
    const hits: MemoryHit[] = [];

    if (kind === 'all' || kind === 'conversation') {
      const rows = params.turnId
        ? (db.prepare('SELECT id, turn_id, role, content, occurred_at FROM conversations WHERE turn_id = ? ORDER BY occurred_at ASC').all(params.turnId) as Array<{
            id: string;
            turn_id: string;
            role: 'user' | 'assistant';
            content: string;
            occurred_at: string;
          }>)
        : (db.prepare('SELECT id, turn_id, role, content, occurred_at FROM conversations ORDER BY occurred_at DESC LIMIT 200').all() as Array<{
            id: string;
            turn_id: string;
            role: 'user' | 'assistant';
            content: string;
            occurred_at: string;
          }>);

      for (const row of rows) {
        if (query && !row.content.toLowerCase().includes(query)) continue;
        hits.push({
          ref: `conv:${row.id}`,
          kind: 'conversation',
          time: row.occurred_at,
          who: row.role === 'assistant' ? '我' : '主人',
          excerpt: clip(row.content, EXCERPT_CHARS),
          turnId: row.turn_id,
        });
        if (hits.length >= limit) return hits;
      }
    }

    if ((kind === 'all' || kind === 'diary') && existsSync(diaryDir)) {
      for (const day of listDiaryDates(diaryDir)) {
        const text = readDiaryEntry(diaryDir, day);
        if (!text) continue;
        if (query && !text.toLowerCase().includes(query)) continue;
        hits.push({
          ref: `diary:${day}`,
          kind: 'diary',
          time: day,
          who: '我（日记）',
          excerpt: clip(text, EXCERPT_CHARS),
        });
        if (hits.length >= limit) return hits;
      }
    }

    return hits;
  }

  function readRef(ref: string, offset = 0, limit = READ_LIMIT_CHARS): { text: string; nextOffset?: number } {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(100, Math.min(8000, Number(limit) || READ_LIMIT_CHARS));
    let full = '';

    if (ref.startsWith('conv:')) {
      const id = ref.slice(5);
      const row = db.prepare('SELECT content FROM conversations WHERE id = ?').get(id) as { content: string } | undefined;
      if (!row) throw new Error(`找不到归档引用 ${ref}`);
      full = row.content;
    } else if (ref.startsWith('diary:')) {
      const day = ref.slice(6);
      const body = readDiaryEntry(diaryDir, day);
      if (body === undefined) throw new Error(`找不到日记 ${day}`);
      full = body;
    } else {
      throw new Error(`无效的记忆引用格式：${ref}`);
    }

    const chars = Array.from(full);
    const slice = chars.slice(safeOffset, safeOffset + safeLimit).join('');
    const nextOffset = safeOffset + safeLimit < chars.length ? safeOffset + safeLimit : undefined;
    return { text: slice, ...(nextOffset !== undefined ? { nextOffset } : {}) };
  }

  function close(): void {
    db.close();
  }

  return { appendMessage, find, readRef, close };
}
