import { describe, it, expect, vi } from 'vitest';
import { SyncScheduler, type SyncSchedulerOptions } from './sync-scheduler';

function make(over: Partial<SyncSchedulerOptions> = {}) {
  const pull = { refreshFile: vi.fn(async () => 'pulled') };
  const push = { flushPending: vi.fn(async () => {}) };
  const opts: SyncSchedulerOptions = {
    pull, push,
    getOpenPaths: () => [],
    isSynced: () => true,
    isOnline: () => true,
    ...over,
  };
  return { scheduler: new SyncScheduler(opts), pull, push };
}

describe('SyncScheduler', () => {
  it('tick(true) : balayage complet tout de suite, hors de son tour', async () => {
    const fullScan = vi.fn(async () => {});
    const { scheduler } = make({ fullScan, fullScanEvery: 12 });
    await scheduler.tick(); // 1er tick : balayage de référence
    await scheduler.tick(); // 2e : pas son tour
    expect(fullScan).toHaveBeenCalledTimes(1);
    await scheduler.tick(true);
    expect(fullScan).toHaveBeenCalledTimes(2);
  });

  it('hors-ligne : ne fait rien', async () => {
    const { scheduler, pull, push } = make({ isOnline: () => false, getOpenPaths: () => ['a.md'] });
    await scheduler.tick();
    expect(push.flushPending).not.toHaveBeenCalled();
    expect(pull.refreshFile).not.toHaveBeenCalled();
  });

  it('chaque tick renvoie le livret (local → Drive)', async () => {
    const { scheduler, push } = make();
    await scheduler.tick();
    expect(push.flushPending).toHaveBeenCalledTimes(1);
  });

  it('ne rafraîchit QUE les notes ouvertes ET synchronisées', async () => {
    const synced = new Set(['ouverte-sync.md', 'fermee-sync.md']);
    const { scheduler, pull } = make({
      getOpenPaths: () => ['ouverte-sync.md', 'ouverte-nonsync.md'], // 2 ouvertes
      isSynced: (p) => synced.has(p),
    });
    await scheduler.tick();
    expect(pull.refreshFile).toHaveBeenCalledTimes(1); // seule ouverte-sync.md
    expect(pull.refreshFile).toHaveBeenCalledWith('ouverte-sync.md');
    // 'ouverte-nonsync.md' (ouverte mais pas synchronisée) et 'fermee-sync.md' (sync mais fermée) ignorées
  });

  it('deux ticks concurrents : le second est ignoré (pas de chevauchement)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { scheduler, push } = make();
    (push.flushPending as ReturnType<typeof vi.fn>).mockImplementation(async () => { await gate; });
    const t1 = scheduler.tick();
    const t2 = scheduler.tick();
    await t2;
    expect(push.flushPending).toHaveBeenCalledTimes(1);
    release();
    await t1;
  });

  it('une erreur en plein tick est capturée (onError), ne casse pas la minuterie', async () => {
    const errors: unknown[] = [];
    const { scheduler, push } = make({ onError: (e) => errors.push(e) });
    (push.flushPending as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline mid-tick'));
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
  });
});
