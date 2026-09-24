import { describe, it, expect } from 'vitest';
import { SelectiveSyncState } from './selective-sync-state';
import type { PersistAdapter } from '../auth/token-store';

function mem() {
  const raw: Record<string, unknown> = {};
  const adapter: PersistAdapter = { async load() { return raw; }, async save(d) { Object.keys(raw).forEach((k) => delete raw[k]); Object.assign(raw, d); } };
  return { adapter, raw };
}

describe('SelectiveSyncState', () => {
  it('pruneMissingChildren : oublie ce qui n existe plus, garde le reste, dossier plus « partiel »', async () => {
    const { adapter } = mem();
    const s = new SelectiveSyncState(adapter); await s.load();
    await s.setFileSynced('dir/gone.md', true);
    await s.setFolderFull('dir/vide', [], [], true);
    await s.setFileSynced('dir/sub/keep.md', true);
    await s.setFileSynced('dir2/a.md', true);
    expect(await s.pruneMissingChildren('dir', new Set(['sub']))).toBe(true);
    expect(s.isSynced('dir/gone.md')).toBe(false);
    expect(s.folderState('dir/vide')).toBe('unchecked');
    expect(s.isSynced('dir/sub/keep.md')).toBe(true);
    expect(s.isSynced('dir2/a.md')).toBe(true);
    expect(await s.pruneMissingChildren('dir', new Set(['sub']))).toBe(false);
    await s.pruneMissingChildren('dir', new Set());
    expect(s.folderState('dir')).toBe('unchecked');
  });

  it('fichier : checked si synchronisé, sinon unchecked', async () => {
    const { adapter } = mem();
    const s = new SelectiveSyncState(adapter); await s.load();
    expect(s.fileState('a.md')).toBe('unchecked');
    await s.setFileSynced('a.md', true);
    expect(s.fileState('a.md')).toBe('checked');
    expect(s.isSynced('a.md')).toBe(true);
    await s.setFileSynced('a.md', false);
    expect(s.fileState('a.md')).toBe('unchecked');
  });

  it('dossier : unchecked / partial / checked', async () => {
    const { adapter } = mem();
    const s = new SelectiveSyncState(adapter); await s.load();
    expect(s.folderState('dir')).toBe('unchecked');
    await s.setFileSynced('dir/x.md', true);            // un descendant coché
    expect(s.folderState('dir')).toBe('partial');
    await s.setFolderFull('dir', ['dir/x.md', 'dir/y.md'], [], true);
    expect(s.folderState('dir')).toBe('checked');
    expect(s.fileState('dir/y.md')).toBe('checked');
  });

  it('décocher un fichier sous un dossier plein → dossier repasse partiel', async () => {
    const { adapter } = mem();
    const s = new SelectiveSyncState(adapter); await s.load();
    await s.setFolderFull('dir', ['dir/x.md', 'dir/y.md'], [], true);
    expect(s.folderState('dir')).toBe('checked');
    await s.setFileSynced('dir/x.md', false);
    expect(s.folderState('dir')).toBe('partial');       // y.md encore synchronisé
    expect(s.fileState('dir/x.md')).toBe('unchecked');
    expect(s.fileState('dir/y.md')).toBe('checked');
  });

  it('décocher un dossier plein retire tout son sous-arbre', async () => {
    const { adapter } = mem();
    const s = new SelectiveSyncState(adapter); await s.load();
    await s.setFolderFull('dir', ['dir/x.md', 'dir/sub/z.md'], ['dir/sub'], true);
    expect(s.folderState('dir/sub')).toBe('checked');
    expect(s.syncedUnder('dir').sort()).toEqual(['dir/sub/z.md', 'dir/x.md']);
    await s.setFolderFull('dir', [], [], false);
    expect(s.folderState('dir')).toBe('unchecked');
    expect(s.folderState('dir/sub')).toBe('unchecked');
    expect(s.syncedUnder('dir')).toEqual([]);
  });

  it('persiste et relit', async () => {
    const { adapter } = mem();
    const a = new SelectiveSyncState(adapter); await a.load();
    await a.setFileSynced('n.md', true);
    const b = new SelectiveSyncState(adapter); await b.load();
    expect(b.fileState('n.md')).toBe('checked');
  });

  it('un préfixe frère ne rend pas un dossier partiel', async () => {
    const { adapter } = mem();
    const s = new SelectiveSyncState(adapter); await s.load();
    await s.setFileSynced('ab/x.md', true);
    // 'a' ne doit PAS être partiel à cause de 'ab/...'
    expect(s.folderState('a')).toBe('unchecked');
    expect(s.folderState('ab')).toBe('partial');
  });

  it('décocher un fichier 3 niveaux démote TOUS les dossiers pleins intermédiaires', async () => {
    const { adapter } = mem();
    const s = new SelectiveSyncState(adapter); await s.load();
    await s.setFolderFull('a', ['a/b/c.md', 'a/b/d.md'], ['a/b'], true);
    expect(s.folderState('a')).toBe('checked');
    expect(s.folderState('a/b')).toBe('checked');
    await s.setFileSynced('a/b/c.md', false);
    // a et a/b repassent partiels (d.md encore synchronisé)
    expect(s.folderState('a')).toBe('partial');
    expect(s.folderState('a/b')).toBe('partial');
    expect(s.fileState('a/b/d.md')).toBe('checked');
  });

  it('allSynced liste tous les fichiers synchronisés', async () => {
    const { adapter } = mem();
    const s = new SelectiveSyncState(adapter); await s.load();
    await s.setFileSynced('a.md', true);
    await s.setFileSynced('b/c.md', true);
    expect(s.allSynced().sort()).toEqual(['a.md', 'b/c.md']);
  });

  it('allFullFolders liste tous les dossiers marqués complets', async () => {
    const { adapter } = mem();
    const s = new SelectiveSyncState(adapter); await s.load();
    await s.setFolderFull('a', [], [], true);
    await s.setFolderFull('b/c', [], [], true);
    expect(s.allFullFolders().sort()).toEqual(['a', 'b/c']);
  });

  it('NFC : un fichier synchronisé en NFD (Drive/macOS) est reconnu quand Obsidian interroge en NFC', async () => {
    const { adapter } = mem();
    const base = 'notes datées/x.md';
    const s = new SelectiveSyncState(adapter); await s.load();
    await s.setFileSynced(base.normalize('NFD'), true); // stocké depuis Drive (NFD)
    expect(s.isSynced(base.normalize('NFC'))).toBe(true); // interrogé par Obsidian (NFC)
    expect(s.fileState(base.normalize('NFC'))).toBe('checked');
  });

  it('NFC : migration au chargement — des clés NFD persistées matchent une requête NFC', async () => {
    const { adapter, raw } = mem();
    const base = 'dossier é/fichier.md';
    raw.syncedFiles = [base.normalize('NFD')]; // état hérité en NFD
    const s = new SelectiveSyncState(adapter); await s.load();
    expect(s.isSynced(base.normalize('NFC'))).toBe(true);
  });
});
