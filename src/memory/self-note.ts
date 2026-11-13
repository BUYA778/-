import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function readSelfNote(selfFile: string, capChars = 1500): { raw: string; rendered: string; truncated: boolean } {
  if (!existsSync(selfFile)) return { raw: '', rendered: '', truncated: false };
  const raw = readFileSync(selfFile, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!raw) return { raw: '', rendered: '', truncated: false };
  const chars = Array.from(raw);
  const truncated = chars.length > capChars;
  const body = truncated ? chars.slice(0, capChars).join('') : raw;
  const rendered = truncated
    ? `<我是谁.md>\n${body}\n</我是谁.md>\n（超出 ${capChars} 字预算，后面 ${chars.length - capChars} 字已折叠，请保留最核心认知）`
    : `<我是谁.md>\n${body}\n</我是谁.md>`;
  return { raw, rendered, truncated };
}

export function writeSelfNote(selfFile: string, content: string, dayKey: string): { snapshotPath?: string } {
  mkdirSync(dirname(selfFile), { recursive: true });
  let snapshotPath: string | undefined;
  if (existsSync(selfFile)) {
    const histDir = join(dirname(selfFile), '我是谁.history');
    mkdirSync(histDir, { recursive: true });
    snapshotPath = join(histDir, `${dayKey}.md`);
    copyFileSync(selfFile, snapshotPath);
  }
  const tmp = `${selfFile}.tmp`;
  writeFileSync(tmp, `${String(content ?? '').trim()}\n`, 'utf8');
  renameSync(tmp, selfFile);
  return { snapshotPath };
}
