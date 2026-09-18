import { App, PluginSettingTab, Setting, Notice, type ButtonComponent, type SettingDefinitionItem } from 'obsidian';
import { CancelToken, isCancelledError } from './util/cancel-token';
import type GoogleDriveFodPlugin from './main';
import { t } from './i18n';
import { confirmModal } from './panel/confirm-modal';

type Mode = 'default' | 'self-hosted';

/** Un réglage, décrit une seule fois : son nom et sa description alimentent la recherche
 *  des réglages d'Obsidian, `construire` dessine la ligne. */
type Ligne = {
  nom: string;
  desc?: string;
  /** Ligne affichée ou non, réévaluée à chaque rendu (état de connexion, mode choisi…). */
  visible?: () => boolean;
  construire: (setting: Setting) => void;
};

/** Onglet de réglages. Déconnecté → seule la section compte (mode + connexion). Connecté →
 *  ajoute « Synchroniser maintenant », le dossier de travail et les réglages du vault. Les
 *  réglages de mode/identifiants sont STAGÉS : ils ne s'appliquent qu'au clic sur
 *  « Enregistrer » d'une barre façon Discord (visible s'il y a une modification).
 *
 *  Deux rendus pour un seul jeu de lignes : Obsidian 1.13 et suivants lisent
 *  `getSettingDefinitions()` - les réglages apparaissent alors dans la recherche des
 *  réglages - et les versions antérieures passent par `display()`. */
export class DriveOnDemandSettingTab extends PluginSettingTab {
  /** Connexion et adresse du compte : lues en asynchrone, gardées ici car les définitions
   *  sont rendues de façon synchrone. */
  private connecte = false;
  private email = '';
  private etatCharge = false;

  // État stagé : appliqué seulement via la barre « Enregistrer ».
  private modeChoisi: Mode = 'default';
  private clientIdSaisi = '';
  private clientSecretSaisi = '';

  constructor(app: App, private plugin: GoogleDriveFodPlugin) {
    super(app, plugin);
  }

  /** Rendu déclaratif (Obsidian 1.13 et suivants) : `display()` n'est alors pas appelé. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    // L'état du compte arrive en asynchrone : une fois lu, `update()` relit les définitions.
    if (!this.etatCharge) void this.chargerEtat().then(() => this.appelerSiPresent('update'));
    const definition = (ligne: Ligne) => ({
      name: ligne.nom,
      desc: ligne.desc,
      visible: ligne.visible,
      render: (setting: Setting) => ligne.construire(setting),
    });
    return [
      ...this.lignesPrincipales().map(definition),
      {
        type: 'group' as const,
        heading: t('settings.vaultHeading'),
        visible: () => this.connecte,
        items: this.lignesVault().map(definition),
      },
      definition(this.ligneEnregistrer()),
    ];
  }

  /** Rendu impératif, pour Obsidian antérieur à 1.13. */
  display(): void {
    void this.rendre();
  }

  /** Redessine l'onglet (après connexion, déconnexion, changement de dossier…). */
  refresh(): void {
    this.etatCharge = false;
    if (!this.appelerSiPresent('update')) void this.rendre();
  }

  /** Appelle une méthode de `SettingTab` apparue en 1.13 si l'Obsidian courant l'a.
   *  Vrai si elle existait. Passe par un type structurel : le plugin déclare 1.7.2, où
   *  ces méthodes n'existent pas encore. */
  private appelerSiPresent(nom: 'update' | 'refreshDomState'): boolean {
    const tab = this as unknown as Record<string, unknown>;
    const methode = tab[nom];
    if (typeof methode !== 'function') return false;
    (methode as () => void).call(this);
    return true;
  }

  private async rendre(): Promise<void> {
    await this.chargerEtat();
    const { containerEl } = this;
    containerEl.empty();
    const dessiner = (ligne: Ligne) => {
      if (ligne.visible && !ligne.visible()) return;
      const setting = new Setting(containerEl).setName(ligne.nom);
      if (ligne.desc) setting.setDesc(ligne.desc);
      ligne.construire(setting);
    };
    this.lignesPrincipales().forEach(dessiner);
    if (this.connecte) {
      new Setting(containerEl).setName(t('settings.vaultHeading')).setDesc(t('settings.vaultDesc')).setHeading();
      this.lignesVault().forEach(dessiner);
    }
    dessiner(this.ligneEnregistrer());
  }

  /** Lit l'état du compte, puis redessine : les définitions, elles, sont synchrones. */
  private async chargerEtat(): Promise<void> {
    if (this.etatCharge) return;
    this.etatCharge = true;
    this.connecte = await this.plugin.isConnected();
    this.email = '';
    if (this.connecte) {
      try { this.email = (await this.plugin.accountEmail()) ?? ''; } catch { /* hors-ligne */ }
    }
    const byo = this.plugin.getByoConfig();
    this.modeChoisi = byo ? 'self-hosted' : 'default';
    this.clientIdSaisi = byo?.clientId ?? '';
    this.clientSecretSaisi = '';
  }

  /** Réévalue les lignes affichées (mode, barre d'enregistrement) sans tout redessiner. */
  private majAffichage(): void {
    if (!this.appelerSiPresent('refreshDomState')) void this.rendre();
  }

  private lignesPrincipales(): Ligne[] {
    return [
      {
        nom: t('settings.accountName'),
        desc: t('settings.accountNotConnected'),
        construire: (setting) => this.construireCompte(setting),
      },
      {
        nom: t('settings.modeName'),
        construire: (setting) => {
          setting.addDropdown((dd) =>
            dd
              .addOption('default', t('settings.modeDefault'))
              .addOption('self-hosted', t('settings.modeSelfHosted'))
              .setValue(this.modeChoisi)
              .onChange((v) => {
                this.modeChoisi = v as Mode;
                this.majAffichage();
              }),
          );
        },
      },
      {
        nom: t('settings.byoRedirectLabel'),
        desc: t('settings.byoRedirectDesc'),
        visible: () => this.modeChoisi === 'self-hosted',
        construire: (setting) => {
          setting.setDesc(`${t('settings.selfHostedDesc')} ${t('settings.byoRedirectDesc')}`);
          setting.addText((text) => {
            text.setValue(this.plugin.byoRedirectUri());
            text.inputEl.readOnly = true;
            text.inputEl.addClass('gdrive-fod-input-full');
          });
        },
      },
      {
        nom: t('settings.byoClientId'),
        visible: () => this.modeChoisi === 'self-hosted',
        construire: (setting) => {
          setting.addText((text) =>
            text.setValue(this.clientIdSaisi).onChange((v) => {
              this.clientIdSaisi = v;
              this.majAffichage();
            }),
          );
        },
      },
      {
        nom: t('settings.byoClientSecret'),
        visible: () => this.modeChoisi === 'self-hosted',
        construire: (setting) => {
          setting.addText((text) => {
            text.setPlaceholder(this.plugin.getByoConfig() ? '••••••••' : t('settings.byoClientSecretPlaceholder'));
            text.inputEl.type = 'password';
            text.onChange((v) => {
              this.clientSecretSaisi = v;
              this.majAffichage();
            });
          });
        },
      },
      {
        nom: t('settings.syncNowName'),
        desc: t('settings.syncNowDesc'),
        visible: () => this.connecte,
        construire: (setting) =>
          this.construireActionLongue(setting, t('settings.syncNow'), async (onProgress, token) => {
            await this.plugin.syncNow(onProgress, token);
            return t('settings.syncNowDone');
          }),
      },
      {
        nom: t('settings.workingRootName'),
        visible: () => this.connecte,
        construire: (setting) => {
          setting.setDesc(
            t('settings.workingRootDesc', { current: this.plugin.getWorkingRootName() ?? t('picker.driveRoot') }),
          );
          setting.addButton((b) =>
            b.setButtonText(t('settings.workingRootChange')).onClick(() => this.plugin.openWorkingRootPicker()),
          );
        },
      },
    ];
  }

  /** Transfert ponctuel du dossier de configuration du vault, dans un sens ou l'autre. */
  private lignesVault(): Ligne[] {
    return [
      {
        nom: t('settings.vaultPushName'),
        desc: t('settings.vaultPushDesc'),
        visible: () => this.connecte,
        construire: (setting) =>
          this.construireActionLongue(
            setting,
            t('settings.vaultPush'),
            async (onProgress, token) => {
              const r = await this.plugin.pushVaultSettings(onProgress, token);
              return t('settings.vaultPushDone', { created: r.created, updated: r.updated });
            },
            t('settings.vaultPushConfirm'),
          ),
      },
      {
        nom: t('settings.vaultPullName'),
        desc: t('settings.vaultPullDesc'),
        visible: () => this.connecte,
        construire: (setting) =>
          this.construireActionLongue(
            setting,
            t('settings.vaultPull'),
            async (onProgress, token) => {
              const r = await this.plugin.pullVaultSettings(onProgress, token);
              return r === 'absent' ? t('settings.vaultPullAbsent') : t('settings.vaultPullDone', { pulled: r.pulled });
            },
            t('settings.vaultPullConfirm'), // confirmation AVANT : le tirage écrase le local
          ),
      },
    ];
  }

  /** Barre « modifications non enregistrées », collée en bas et affichée seulement si le
   *  mode ou les identifiants ont changé. */
  private ligneEnregistrer(): Ligne {
    return {
      nom: t('settings.unsaved'),
      visible: () => this.modifie(),
      construire: (setting) => {
        setting.settingEl.addClass('dod-save-bar');
        setting.addButton((b) =>
          b.setButtonText(t('settings.save')).setCta().onClick(() => void this.enregistrer()),
        );
      },
    };
  }

  /** Vrai si le mode ou les identifiants saisis diffèrent de ce qui est enregistré. */
  private modifie(): boolean {
    const existant = this.plugin.getByoConfig();
    const modeEnregistre: Mode = existant ? 'self-hosted' : 'default';
    if (this.modeChoisi !== modeEnregistre) return true;
    if (this.modeChoisi === 'self-hosted') {
      if (this.clientIdSaisi.trim() !== (existant?.clientId ?? '')) return true;
      if (this.clientSecretSaisi.trim() !== '') return true;
    }
    return false;
  }

  private async enregistrer(): Promise<void> {
    const existant = this.plugin.getByoConfig();
    if (this.modeChoisi === 'self-hosted') {
      // Secret laissé vide = on conserve l'existant.
      const secret = this.clientSecretSaisi.trim() || existant?.clientSecret || '';
      if (!this.clientIdSaisi.trim() || !secret) {
        new Notice(t('settings.byoMissing'));
        return;
      }
      await this.plugin.setByoConfig({ clientId: this.clientIdSaisi.trim(), clientSecret: secret });
    } else if (existant) {
      await this.plugin.clearByoConfig(); // retour au mode par défaut
    }
    new Notice(t('settings.saved'));
    this.refresh();
  }

  private construireCompte(setting: Setting): void {
    if (!this.connecte) {
      setting.setDesc(t('settings.accountNotConnected')).addButton((b) =>
        b.setButtonText(t('settings.connect')).setCta().onClick(() => {
          this.plugin.startAuth();
          new Notice(t('settings.connectStarted'));
        }),
      );
      return;
    }
    setting
      .setDesc(this.email ? t('settings.accountConnected', { email: this.email }) : t('settings.accountConnectedNoEmail'))
      .addButton((b) =>
        b.setButtonText(t('settings.disconnect')).setClass('mod-warning').onClick(async () => {
          await this.plugin.disconnect();
          new Notice(t('settings.disconnected'));
          this.refresh();
        }),
      );
  }

  /** Action longue : le bouton affiche la progression en %, et un bouton « Annuler »
   *  n'apparaît que pendant l'exécution. */
  private construireActionLongue(
    setting: Setting,
    label: string,
    run: (onProgress: (done: number, total: number) => void, token: CancelToken) => Promise<string>,
    confirmMsg?: string,
  ): void {
    let token: CancelToken | null = null;
    let cancelBtn: ButtonComponent | null = null;

    setting.addButton((b) =>
      b.setButtonText(label).onClick(async () => {
        if (confirmMsg && !(await confirmModal(this.app, confirmMsg, label))) return;
        token = new CancelToken();
        if (cancelBtn) cancelBtn.buttonEl.show();
        b.setDisabled(true);
        try {
          const msg = await run((done, total) => {
            b.setButtonText(total > 0 ? `${Math.round((done / total) * 100)} %` : label);
          }, token);
          new Notice(msg);
        } catch (e) {
          new Notice(isCancelledError(e) ? t('settings.cancelled') : t('settings.vaultError', { error: String(e) }));
        } finally {
          token = null;
          b.setDisabled(false).setButtonText(label);
          if (cancelBtn) cancelBtn.buttonEl.hide();
        }
      }),
    );
    setting.addButton((b) => {
      cancelBtn = b;
      b.setButtonText(t('settings.cancel')).onClick(() => token?.cancel());
      // Classe que pose `setWarning` : `setDestructive`, son remplaçant, n'existe qu'à partir de 1.13.
      b.buttonEl.addClass('mod-warning');
      b.buttonEl.hide();
    });
  }
}
