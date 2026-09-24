import type { VaultOps } from '../mirror/tree-mirror';
import type { DriveClient } from '../drive/drive-client';
import type { MirrorIndex } from '../mirror/mirror-index';
import type { SelectiveSyncState } from './selective-sync-state';
import { hashContent } from '../util/content-hash';
import { conflictName, defaultConflictLabel } from '../util/conflict-name';
import { isText } from '../mirror/hydrator';
import { isGoogleNative } from '../drive/drive-client';
import type { PathLocks } from '../util/path-locks';

export type RefreshResult = 'up-to-date' | 'pulled' | 'conflict' | 'not-synced';

export interface PullManagerOptions {
  vault: VaultOps;
  drive: DriveClient;
  index: MirrorIndex;
  state: SelectiveSyncState;
  onConflict?: (path: string, conflictPath: string) => void;
  onStatus?: (kind: 'busy' | 'ok' | 'error') => void;
  now?: () => string;
  /** Partagé avec PushManager : envoi et rafraîchissement d'un même fichier sérialisés. */
  locks?: PathLocks;
  /** Modifications locales en attente d'envoi : ne pas rafraîchir, l'envoi s'en charge
   *  (et vérifie lui-même un éventuel conflit). */
  hasLocalPending?: (path: string) => boolean;
}

export class PullManager {
  constructor(private opts: PullManagerOptions) {}

  private label(): string {
    return (this.opts.now ?? (() => defaultConflictLabel()))();
  }

  refreshFile(path: string): Promise<RefreshResult> {
    return this.opts.locks ? this.opts.locks.run(path, () => this.refreshNow(path)) : this.refreshNow(path);
  }

  private async refreshNow(path: string): Promise<RefreshResult> {
    const entry = this.opts.index.get(path);
    if (!entry || !this.opts.state.isSynced(path)) return 'not-synced';
    if (isGoogleNative(entry.mimeType)) return 'up-to-date'; // lien statique, rien à retélécharger/comparer
    if (this.opts.hasLocalPending?.(path)) return 'up-to-date';
    const remote = await this.opts.drive.getRevision(entry.driveId);
    if (!remote.headRevisionId || remote.headRevisionId === entry.headRevisionId) return 'up-to-date';

    this.opts.onStatus?.('busy');

    if (!isText(entry.mimeType, path)) {
      // binaire : pas de push-back donc pas de conflit possible — on retélécharge simplement
      const buffer = await this.opts.drive.readBinary(entry.driveId);
      await this.opts.vault.writeBinary(path, buffer);
      await this.opts.index.setRevision(path, remote.headRevisionId);
      this.opts.onStatus?.('ok');
      return 'pulled';
    }

    const local = await this.opts.vault.readText(path);
    const lh = hashContent(local);
    const rc = await this.opts.drive.readText(entry.driveId);
    const rh = hashContent(rc);
    if (rh === lh || rh === entry.syncedHash) {
      // Même contenu des deux côtés, ou distant inchangé (seule la révision a bougé) :
      // on note la révision sans réécrire le fichier ouvert. Une édition locale éventuelle
      // partira par l'envoi normal.
      await this.opts.index.setRevision(path, remote.headRevisionId);
      if (rh === lh) await this.opts.index.setSyncedHash(path, lh);
      this.opts.onStatus?.('ok');
      return 'up-to-date';
    }
    if (lh === entry.syncedHash) {
      // pas d'édition locale → prend le distant
      await this.opts.vault.writeText(path, rc);
      await this.opts.index.setSyncedHash(path, rh);
      await this.opts.index.setRevision(path, remote.headRevisionId);
      this.opts.onStatus?.('ok');
      return 'pulled';
    }
    // les deux ont vraiment changé → copie conflit du distant, on garde le local ET on le pousse
    const cp = conflictName(path, this.label());
    await this.opts.vault.writeText(cp, rc);
    this.opts.onConflict?.(path, cp);
    const newRev = await this.opts.drive.updateText(entry.driveId, local);
    if (newRev) await this.opts.index.setRevision(path, newRev);
    await this.opts.index.setSyncedHash(path, hashContent(local));
    this.opts.onStatus?.('ok');
    return 'conflict';
  }

  async refreshAllSynced(): Promise<{ pulled: number; conflicts: number }> {
    let pulled = 0;
    let conflicts = 0;
    for (const p of this.opts.state.allSynced()) {
      const r = await this.refreshFile(p);
      if (r === 'pulled') pulled++;
      else if (r === 'conflict') conflicts++;
    }
    return { pulled, conflicts };
  }
}
