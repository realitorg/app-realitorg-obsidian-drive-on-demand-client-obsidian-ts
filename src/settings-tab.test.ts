import { describe, it, expect } from 'vitest';
import { DriveOnDemandSettingTab } from './settings-tab';
import { setLang } from './i18n';

// Libellés attendus en français, quelle que soit la langue de la machine de test.
setLang('fr');

type Definition = { name: string; visible?: () => boolean; type?: string; items?: Definition[] };

/** Plugin réduit à ce que lit l'onglet. */
function pluginFactice(options: { connecte?: boolean; byo?: { clientId: string; clientSecret: string } } = {}) {
  return {
    isConnected: async () => options.connecte ?? false,
    accountEmail: async () => 'moi@example.com',
    getByoConfig: () => options.byo ?? null,
    byoRedirectUri: () => 'https://exemple/callback-byo',
    getWorkingRootName: () => null,
  };
}

async function onglet(options: Parameters<typeof pluginFactice>[0] = {}) {
  const tab = new DriveOnDemandSettingTab({} as never, pluginFactice(options) as never);
  tab.getSettingDefinitions(); // lance la lecture de l'état du compte
  await new Promise((r) => setTimeout(r, 0));
  return tab;
}

function visibles(definitions: Definition[]): string[] {
  const noms: string[] = [];
  for (const d of definitions) {
    if (d.visible && !d.visible()) continue;
    if (d.type === 'group') { noms.push(...visibles(d.items ?? [])); continue; }
    noms.push(d.name);
  }
  return noms;
}

describe('DriveOnDemandSettingTab.getSettingDefinitions', () => {
  it('déconnecté : compte et mode seulement', async () => {
    const tab = await onglet();
    const noms = visibles(tab.getSettingDefinitions() as Definition[]);
    expect(noms).toEqual(['Compte', 'Mode de connexion']);
  });

  it('connecté : ajoute la synchronisation, le dossier de travail et les réglages du vault', async () => {
    const tab = await onglet({ connecte: true });
    const noms = visibles(tab.getSettingDefinitions() as Definition[]);
    expect(noms).toContain('Synchroniser maintenant');
    expect(noms).toContain('Dossier de travail');
    expect(noms).toContain('Téléverser mes réglages');
    expect(noms).toContain('Tirer les réglages');
  });

  it('mode auto-hébergé : affiche les identifiants, sans barre d’enregistrement tant que rien ne change', async () => {
    const tab = await onglet({ byo: { clientId: 'ID', clientSecret: 'SECRET' } });
    const noms = visibles(tab.getSettingDefinitions() as Definition[]);
    expect(noms).toContain('Client ID');
    expect(noms).toContain('Client secret');
    expect(noms).not.toContain('Modifications non enregistrées');
  });

  it('toutes les lignes portent un nom (recherche des réglages d’Obsidian)', async () => {
    const tab = await onglet({ connecte: true });
    const toutes = (tab.getSettingDefinitions() as Definition[]).flatMap((d) => (d.type === 'group' ? (d.items ?? []) : [d]));
    expect(toutes.every((d) => typeof d.name === 'string' && d.name.length > 0)).toBe(true);
  });
});

describe('rendu impératif (Obsidian antérieur à 1.13)', () => {
  it('display() dessine sans erreur', async () => {
    const tab = await onglet({ connecte: true });
    expect(() => tab.display()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('barre « modifications non enregistrées »', () => {
  it('apparaît dès que le mode choisi diffère de celui enregistré', async () => {
    const tab = await onglet();
    (tab as unknown as { modeChoisi: string }).modeChoisi = 'self-hosted';
    const noms = visibles(tab.getSettingDefinitions() as Definition[]);
    expect(noms).toContain('Modifications non enregistrées');
  });
});
