import type { MirrorIndex } from '../mirror/mirror-index';
import type { SelectiveSyncState } from './selective-sync-state';
import { untrackPaths } from '../mirror/reindex';
import { toNfc } from '../util/nfc';

/** Au-delà, une suppression n'est répercutée de l'autre côté qu'après confirmation :
 *  protège contre une suppression massive involontaire (ou un bug du plugin). */
export const MASS_DELETE_THRESHOLD = 10;

/** Chemins de `paths` qui ne sont sous aucun autre : traiter un dossier suffit pour son contenu. */
export function topLevel(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((p) => !unique.some((o) => o !== p && p.startsWith(o + '/')));
}

/** Suppressions locales faites par le plugin lui-même (désynchronisation, changement de
 *  dossier de travail, suppression venue de Drive). Obsidian émet pour elles le même
 *  événement `delete` qu'une suppression de l'utilisateur : elles ne doivent jamais partir
 *  vers Drive. Une marque couvre le chemin et tout son sous-arbre, et expire après `ttlMs`. */
export class RecentRemovals {
  private marks = new Map<string, number>();

  constructor(private now: () => number = Date.now, private ttlMs = 60_000) {}

  mark(path: string): void {
    this.marks.set(toNfc(path), this.now());
  }

  covers(path: string): boolean {
    const np = toNfc(path);
    const t = this.now();
    let hit = false;
    for (const [p, at] of this.marks) {
      if (t - at > this.ttlMs) this.marks.delete(p);
      else if (np === p || np.startsWith(p + '/')) hit = true;
    }
    return hit;
  }
}

export interface LocalDeleteRelayOptions {
  index: MirrorIndex;
  state: SelectiveSyncState;
  drive: { trashFile(fileId: string): Promise<void> };
  outbox?: { all(): string[]; remove(path: string): Promise<void> };
  isPluginRemoval: (path: string) => boolean;
  /** Plus de MASS_DELETE_THRESHOLD éléments : vrai si l'utilisateur confirme. */
  confirmMass: (count: number) => Promise<boolean>;
  delayMs?: number;
  onError?: (path: string, err: unknown) => void;
  onDone?: () => void;
}

/** Répercute sur Drive une suppression faite par l'utilisateur dans le vault : l'élément
 *  suivi part dans la corbeille Drive (récupérable 30 jours), jamais en suppression
 *  définitive. Les événements sont regroupés (`delayMs`) : supprimer un dossier en émet un
 *  par fichier, et le seuil de confirmation porte sur l'ensemble. */
export class LocalDeleteRelay {
  private pending = new Set<string>();
  private timer?: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(private opts: LocalDeleteRelayOptions) {}

  onDelete(path: string): void {
    const np = toNfc(path);
    // vérifié tout de suite, à l'émission : la marque d'une suppression du plugin expire
    if (this.opts.isPluginRemoval(np) || !this.isTracked(np)) return;
    this.pending.add(np);
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), this.opts.delayMs ?? 1000);
  }

  flush(): Promise<void> {
    window.clearTimeout(this.timer);
    const paths = [...this.pending];
    this.pending.clear();
    const run = this.queue.then(() => this.apply(paths));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private isTracked(path: string): boolean {
    return this.opts.index.has(path) || this.opts.index.paths().some((p) => p.startsWith(path + '/'));
  }

  /** Éléments suivis à mettre à la corbeille : le chemin lui-même s'il est suivi, sinon ses
   *  descendants suivis les plus hauts (dossier local jamais indexé, contenu suivi). */
  private targets(paths: string[]): string[] {
    const all = this.opts.index.paths();
    return topLevel(paths.flatMap((p) => (this.opts.index.has(p) ? [p] : all.filter((q) => q.startsWith(p + '/')))));
  }

  private async apply(paths: string[]): Promise<void> {
    const targets = this.targets(paths);
    if (targets.length === 0) return;
    const propagate = targets.length <= MASS_DELETE_THRESHOLD || (await this.opts.confirmMass(targets.length));
    for (const p of targets) {
      const entry = this.opts.index.get(p);
      if (propagate && entry) {
        try {
          await this.opts.drive.trashFile(entry.driveId);
        } catch (e) {
          this.opts.onError?.(p, e); // le fichier reste sur Drive : rien n'est perdu
        }
      }
      for (const q of this.opts.outbox?.all() ?? []) {
        if (q === p || q.startsWith(p + '/')) await this.opts.outbox?.remove(q);
      }
      await untrackPaths(this.opts.index, this.opts.state, p);
    }
    this.opts.onDone?.();
  }
}
