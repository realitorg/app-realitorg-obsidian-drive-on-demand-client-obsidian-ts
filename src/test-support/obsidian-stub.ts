// Stub minimal du module 'obsidian' pour les tests unitaires (le vrai module n'est
// disponible qu'à l'exécution dans Obsidian). Aliasé via vitest.config.ts. On n'expose
// que ce dont les fichiers sous test ont besoin ; les instances servent aux `instanceof`.
export class TFile {
  path: string;
  constructor(path = '') { this.path = path; }
}
export class TFolder {
  path: string;
  children: unknown[] = [];
  constructor(path = '') { this.path = path; }
}
export class Vault {}
export function normalizePath(p: string): string {
  return p;
}
export function setIcon(_el: unknown, _icon: string): void {
  // no-op en test
}
export class App {}
export class WorkspaceLeaf {}
export class Notice {
  constructor(_msg?: string) {}
}
export class Component {
  registerDomEvent(): void {}
  registerEvent(): void {}
  register(): void {}
}
export class ItemView extends Component {
  constructor(_leaf?: unknown) { super(); }
}
export class Modal {
  contentEl = { createEl() { return {}; }, createDiv() { return {}; }, empty() {} };
  titleEl = { setText() {} };
  modalEl = { addClass() {} };
  constructor(_app?: unknown) {}
  open(): void {}
  close(): void {}
  onClose(): void {}
}

/** Composant de réglage : chaîne comme le vrai, et retient ce qu'on lui demande. */
export class Setting {
  nom = '';
  desc = '';
  boutons: string[] = [];
  settingEl = { addClass() {} };
  constructor(_containerEl?: unknown) {}
  setName(v: string): this { this.nom = v; return this; }
  setDesc(v: string): this { this.desc = v; return this; }
  setHeading(): this { return this; }
  addButton(cb: (b: unknown) => unknown): this {
    const bouton = {
      setButtonText: (v: string) => { this.boutons.push(v); return bouton; },
      setCta: () => bouton, setClass: () => bouton, setDisabled: () => bouton,
      onClick: () => bouton, buttonEl: { addClass() {}, show() {}, hide() {} },
    };
    cb(bouton);
    return this;
  }
  addDropdown(cb: (d: unknown) => unknown): this {
    const dd = { addOption: () => dd, setValue: () => dd, onChange: () => dd };
    cb(dd);
    return this;
  }
  addText(cb: (x: unknown) => unknown): this {
    const text = {
      setValue: () => text, setPlaceholder: () => text, onChange: () => text,
      inputEl: { readOnly: false, type: '', addClass() {} },
    };
    cb(text);
    return this;
  }
}

export class PluginSettingTab {
  containerEl = {
    empty() {}, createDiv() { return { empty() {}, createEl() { return { addClass() {} }; } }; },
  };
  constructor(public app: unknown, _plugin?: unknown) {}
}
