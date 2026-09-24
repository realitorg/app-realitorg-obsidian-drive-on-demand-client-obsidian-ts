import type { VaultOps } from '../mirror/tree-mirror';
import type { DriveClient } from '../drive/drive-client';
import type { MirrorIndex } from '../mirror/mirror-index';
import type { SelectiveSyncState } from './selective-sync-state';
import { hashContent } from '../util/content-hash';
import { conflictName, defaultConflictLabel } from '../util/conflict-name';
import { isText } from '../mirror/hydrator';
import { isGoogleNative } from '../drive/drive-client';
import type { OutboxStore } from './outbox';
import type { PathLocks } from '../util/path-locks';

export interface PushManagerOptions {
  vault: VaultOps;
  drive: DriveClient;
  index: MirrorIndex;
  state: SelectiveSyncState;
  outbox?: OutboxStore;
  debounceMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (h: number) => void;
  onError?: (path: string, err: unknown) => void;
  onConflict?: (path: string, conflictPath: string) => void;
  onStatus?: (kind: 'busy' | 'ok' | 'error') => void;
  now?: () => string;
  /** Partagé avec PullManager : envoi et rafraîchissement d'un même fichier sérialisés. */
  locks?: PathLocks;
}

export class PushManager {
  private timers = new Map<string, number>();
  private debounceMs: number;
  private setT: (fn: () => void, ms: number) => number;
  private clearT: (h: number) => void;

  constructor(private opts: PushManagerOptions) {
    this.debounceMs = opts.debounceMs ?? 2000;
    this.setT = opts.setTimeoutFn ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.clearT = opts.clearTimeoutFn ?? ((h) => window.clearTimeout(h));
  }

  onModify(path: string): void {
    if (!this.opts.state.isSynced(path)) return;
    const existing = this.timers.get(path);
    if (existing) this.clearT(existing);
    this.timers.set(
      path,
      this.setT(() => {
        this.timers.delete(path);
        this.flush(path).catch((e) => this.opts.onError?.(path, e));
      }, this.debounceMs),
    );
  }

  /** Envoie tout de suite les modifications encore en attente du délai (départ de l'app :
   *  iOS la suspend quelques secondes après, le délai n'aurait pas le temps d'expirer). */
  async flushDebounced(): Promise<void> {
    const paths = [...this.timers.keys()];
    for (const p of paths) {
      this.clearT(this.timers.get(p) as number);
      this.timers.delete(p);
    }
    await Promise.all(paths.map((p) => this.flush(p).catch((e) => this.opts.onError?.(p, e))));
  }

  /** Modifications locales pas encore envoyées (délai en cours ou livret). */
  hasPending(path: string): boolean {
    return this.timers.has(path) || (this.opts.outbox?.has(path) ?? false);
  }

  flush(path: string): Promise<void> {
    return this.opts.locks ? this.opts.locks.run(path, () => this.flushNow(path)) : this.flushNow(path);
  }

  private async flushNow(path: string): Promise<void> {
    const entry = this.opts.index.get(path);
    if (!entry || !this.opts.state.isSynced(path)) return;
    if (isGoogleNative(entry.mimeType) || !isText(entry.mimeType, path)) return; // jamais de push pour un binaire ou un lien Google natif
    const content = await this.opts.vault.readText(path);
    const h = hashContent(content);
    if (entry.syncedHash === h) return; // pas de vrai changement local

    this.opts.onStatus?.('busy');
    try {
      // conflit : le distant a-t-il bougé depuis notre dernière sync ?
      const remote = await this.opts.drive.getRevision(entry.driveId);
      if (entry.headRevisionId && remote.headRevisionId && remote.headRevisionId !== entry.headRevisionId) {
        const remoteContent = await this.opts.drive.readText(entry.driveId);
        const rh = hashContent(remoteContent);
        // Vrai conflit seulement si le CONTENU distant diffère à la fois de ce qu'on avait
        // synchronisé et de ce qu'on envoie : une révision qui change sans contenu nouveau
        // (ou avec le même contenu) n'en est pas un.
        if (rh !== entry.syncedHash && rh !== h) {
          const label = (this.opts.now ?? (() => defaultConflictLabel()))();
          const cp = conflictName(path, label);
          await this.opts.vault.writeText(cp, remoteContent);
          this.opts.onConflict?.(path, cp);
        }
      }

      const newRev = await this.opts.drive.updateText(entry.driveId, content);
      await this.opts.index.setSyncedHash(path, h);
      if (newRev) await this.opts.index.setRevision(path, newRev);
      await this.opts.outbox?.remove(path); // push abouti → plus en attente
      this.opts.onStatus?.('ok');
    } catch (err) {
      // échec (typiquement hors-ligne) → on inscrit au livret pour re-tenter plus tard,
      // garantissant qu'aucune modif locale n'est perdue même après un redémarrage.
      await this.opts.outbox?.add(path);
      this.opts.onStatus?.('error');
      throw err;
    }
  }

  /** Re-tente tous les push en attente (livret). Appelé par le planificateur au retour
   *  en ligne / à chaque tick. Un échec laisse l'entrée dans le livret pour le tick suivant. */
  async flushPending(): Promise<void> {
    if (!this.opts.outbox) return;
    for (const path of this.opts.outbox.all()) {
      try {
        await this.flush(path);
      } catch {
        // reste dans le livret, re-tenté au prochain tick
      }
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) this.clearT(t);
    this.timers.clear();
  }
}
