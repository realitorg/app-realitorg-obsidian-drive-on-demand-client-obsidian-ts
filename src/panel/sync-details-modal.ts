import { App, Modal, setIcon } from 'obsidian';
import type { TreeNode } from './tree-model';
import { t } from '../i18n';

export type SyncStatusKind = 'offline' | 'partial' | 'online' | 'syncing';

export interface SyncStatus {
  kind: SyncStatusKind;
  /** Sync de dossier en cours : fichiers traités / total. */
  progress?: { done: number; total: number };
  /** Fichiers en échec lors de la dernière sync de ce nœud. */
  failed: string[];
}

/** Ce que la modale lit et déclenche ; implémenté par le panneau Drive. */
export interface SyncDetailsController {
  status(node: TreeNode): SyncStatus;
  /** Fichiers de ce dossier disponibles hors ligne. */
  syncedCount(node: TreeNode): number;
  /** Nombre total de fichiers du dossier sur Drive (lu à la demande). */
  totalCount(node: TreeNode): Promise<number>;
  makeOffline(node: TreeNode): void;
  freeUp(node: TreeNode): void;
  cancel(node: TreeNode): void;
}

const STATUS_ICON: Record<SyncStatusKind, string> = {
  offline: 'check-circle-2',
  partial: 'circle-dashed',
  online: 'cloud',
  syncing: 'refresh-cw',
};

/** Détails et actions de synchronisation d'un fichier ou dossier (appui long, clic droit,
 *  ou toucher de l'icône d'état). Se met à jour tant qu'elle est ouverte (`refresh`). */
export class SyncDetailsModal extends Modal {
  private total?: number;

  constructor(app: App, readonly node: TreeNode, private ctl: SyncDetailsController, private onClosed: () => void) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.node.name);
    this.refresh();
    if (this.node.isFolder) {
      void this.ctl.totalCount(this.node).then(
        (n) => { this.total = n; this.refresh(); },
        () => { this.total = undefined; },
      );
    }
  }

  onClose(): void {
    this.contentEl.empty();
    this.onClosed();
  }

  refresh(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass('gdrive-fod-details');
    const st = this.ctl.status(this.node);

    if (this.node.path.includes('/')) {
      el.createDiv({ cls: 'gdrive-fod-details-path', text: this.node.path.split('/').slice(0, -1).join(' / ') });
    }

    const line = el.createDiv({ cls: `gdrive-fod-details-status is-${st.kind}` });
    setIcon(line.createSpan({ cls: 'gdrive-fod-details-status-icon' }), STATUS_ICON[st.kind]);
    line.createSpan({ text: t(`details.status.${st.kind}`) });

    if (this.node.isFolder && st.kind !== 'syncing') {
      const synced = this.ctl.syncedCount(this.node);
      el.createDiv({
        cls: 'gdrive-fod-details-count',
        text: this.total === undefined
          ? t('details.countLoading', { synced })
          : t('details.count', { synced, total: this.total }),
      });
    }

    if (st.kind === 'syncing') {
      const prog = st.progress;
      const bar = el.createEl('progress', { cls: 'gdrive-fod-details-progress' });
      if (prog && prog.total > 0) {
        bar.max = prog.total;
        bar.value = prog.done;
        el.createDiv({ cls: 'gdrive-fod-details-count', text: t('details.progress', { done: prog.done, total: prog.total }) });
      }
    }

    if (st.failed.length > 0) {
      const box = el.createDiv({ cls: 'gdrive-fod-details-failed' });
      box.createDiv({ text: t('details.failed', { count: st.failed.length }) });
      const list = box.createEl('ul');
      for (const p of st.failed.slice(0, 5)) list.createEl('li', { text: p.split('/').pop() ?? p });
      if (st.failed.length > 5) list.createEl('li', { text: t('details.failedMore', { count: st.failed.length - 5 }) });
    }

    const actions = el.createDiv({ cls: 'gdrive-fod-details-actions' });
    const button = (label: string, cls: string, onClick: () => void) => {
      const b = actions.createEl('button', { text: label, cls });
      b.onclick = onClick;
    };
    if (st.kind === 'syncing') {
      button(t('details.cancel'), '', () => this.ctl.cancel(this.node));
    } else {
      if (st.kind !== 'offline' || st.failed.length > 0) {
        button(st.failed.length > 0 ? t('details.retry') : t('details.makeOffline'), 'mod-cta', () => this.ctl.makeOffline(this.node));
      }
      if (st.kind !== 'online') {
        button(t('details.freeUp'), '', () => this.ctl.freeUp(this.node));
      }
    }
    button(t('details.openInDrive'), '', () => window.open(`https://drive.google.com/open?id=${encodeURIComponent(this.node.id)}`, '_blank'));

    if (st.kind !== 'online' && st.kind !== 'syncing') {
      el.createDiv({ cls: 'gdrive-fod-details-hint', text: t('details.freeUpHint') });
    }
  }
}
