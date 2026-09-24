import { describe, it, expect, vi } from 'vitest';
import { LocalDeleteRelay, RecentRemovals, topLevel, type LocalDeleteRelayOptions } from './delete-relay';
import { MirrorIndex, type MirrorEntry } from '../mirror/mirror-index';
import { SelectiveSyncState } from './selective-sync-state';
import type { PersistAdapter } from '../auth/token-store';

function ad(): PersistAdapter {
  const raw: Record<string, unknown> = {};
  return { async load() { return raw; }, async save(d) { Object.keys(raw).forEach((k) => delete raw[k]); Object.assign(raw, d); } };
}
const fileEntry = (driveId: string): MirrorEntry => ({ driveId, mimeType: 'text/markdown', isFolder: false, hydrated: true, pinned: true });
const folderEntry = (driveId: string): MirrorEntry => ({ driveId, mimeType: 'application/vnd.google-apps.folder', isFolder: true, hydrated: true, pinned: true });

async function setup(extra: Partial<LocalDeleteRelayOptions> = {}) {
  const index = new MirrorIndex(ad()); await index.load();
  const state = new SelectiveSyncState(ad()); await state.load();
  await index.set('dir', folderEntry('DIR'));
  await index.set('dir/a.md', fileEntry('A'));
  await index.set('dir/b.md', fileEntry('B'));
  await state.setFolderFull('dir', ['dir/a.md', 'dir/b.md'], [], true);
  const drive = { trashFile: vi.fn(async () => {}) };
  const removals = new RecentRemovals();
  const confirmMass = vi.fn(async () => true);
  const relay = new LocalDeleteRelay({
    index, state, drive, confirmMass, isPluginRemoval: (p) => removals.covers(p), ...extra,
  });
  return { index, state, drive, removals, confirmMass, relay };
}

describe('topLevel', () => {
  it('garde les chemins qui ne sont sous aucun autre, sans doublon', () => {
    expect(topLevel(['a/b', 'a', 'c', 'c', 'ab'])).toEqual(['a', 'c', 'ab']);
  });
});

describe('RecentRemovals', () => {
  it('couvre le chemin marqué et son sous-arbre, pas un voisin au préfixe proche', () => {
    const r = new RecentRemovals();
    r.mark('dir');
    expect(r.covers('dir')).toBe(true);
    expect(r.covers('dir/a.md')).toBe(true);
    expect(r.covers('dir2/a.md')).toBe(false);
  });

  it('la marque expire', () => {
    let now = 0;
    const r = new RecentRemovals(() => now, 1000);
    r.mark('a.md');
    now = 1001;
    expect(r.covers('a.md')).toBe(false);
  });
});

describe('LocalDeleteRelay', () => {
  it('suppression locale d un fichier suivi → corbeille Drive, plus suivi, parent reste plein', async () => {
    const { relay, drive, index, state } = await setup();
    relay.onDelete('dir/a.md');
    await relay.flush();
    expect(drive.trashFile).toHaveBeenCalledWith('A');
    expect(index.has('dir/a.md')).toBe(false);
    expect(state.isSynced('dir/a.md')).toBe(false);
    expect(state.folderState('dir')).toBe('checked');
  });

  it('dossier supprimé (un événement par élément) → une seule corbeille Drive, celle du dossier', async () => {
    const { relay, drive, index } = await setup();
    relay.onDelete('dir/a.md');
    relay.onDelete('dir/b.md');
    relay.onDelete('dir');
    await relay.flush();
    expect(drive.trashFile).toHaveBeenCalledTimes(1);
    expect(drive.trashFile).toHaveBeenCalledWith('DIR');
    expect(index.paths()).toEqual([]);
  });

  it('suppression faite par le plugin (désynchronisation) → jamais envoyée à Drive', async () => {
    const { relay, drive, removals, index } = await setup();
    removals.mark('dir'); // comme ObsidianVaultOps.remove avant de supprimer
    relay.onDelete('dir/a.md');
    relay.onDelete('dir');
    await relay.flush();
    expect(drive.trashFile).not.toHaveBeenCalled();
    expect(index.has('dir')).toBe(true); // l'appelant (désync) gère lui-même l'index
  });

  it('élément non suivi → ignoré', async () => {
    const { relay, drive } = await setup();
    relay.onDelete('ailleurs/x.md');
    await relay.flush();
    expect(drive.trashFile).not.toHaveBeenCalled();
  });

  it('plus de 10 éléments refusés → rien sur Drive, plus suivis', async () => {
    const confirmMass = vi.fn(async () => false);
    const { relay, drive, index } = await setup({ confirmMass });
    for (let k = 0; k < 11; k++) await index.set(`n${k}.md`, fileEntry(`N${k}`));
    for (let k = 0; k < 11; k++) relay.onDelete(`n${k}.md`);
    await relay.flush();
    expect(confirmMass).toHaveBeenCalledWith(11);
    expect(drive.trashFile).not.toHaveBeenCalled();
    expect(index.has('n0.md')).toBe(false);
  });

  it('10 éléments → pas de confirmation', async () => {
    const { relay, drive, index, confirmMass } = await setup();
    for (let k = 0; k < 10; k++) await index.set(`n${k}.md`, fileEntry(`N${k}`));
    for (let k = 0; k < 10; k++) relay.onDelete(`n${k}.md`);
    await relay.flush();
    expect(confirmMass).not.toHaveBeenCalled();
    expect(drive.trashFile).toHaveBeenCalledTimes(10);
  });

  it('échec Drive (hors ligne) → signalé, le fichier reste sur Drive', async () => {
    const onError = vi.fn();
    const drive = { trashFile: vi.fn(async () => { throw new Error('offline'); }) };
    const { relay } = await setup({ drive, onError });
    relay.onDelete('dir/a.md');
    await relay.flush();
    expect(onError).toHaveBeenCalledWith('dir/a.md', expect.any(Error));
  });
});
