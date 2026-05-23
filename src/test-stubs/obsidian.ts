type RequestUrlMock = (input: unknown) => Promise<unknown>;

let requestUrlMock: RequestUrlMock | null = null;
const buttonComponents: MockButtonComponent[] = [];
const textComponents: MockTextComponent[] = [];
const toggleComponents: MockToggleComponent[] = [];
const progressBarComponents: MockProgressBarComponent[] = [];
const extraButtonComponents: MockExtraButtonComponent[] = [];
const createdElementTexts: string[] = [];
const settingNames: string[] = [];
const settingDescriptions: string[] = [];

class MockElement {
  text = "";

  empty(): void {}

  createEl(_tag: string, options?: { text?: string; cls?: string; href?: string }): MockElement {
    const element = new MockElement();
    if (options?.text) {
      element.text = options.text;
      createdElementTexts.push(options.text);
    }
    return element;
  }

  setText(value: string): void {
    this.text = value;
  }

  appendText(_val: string): void {}

  setAttr(_attr: string, _value: string): void {}
}

export class MockButtonComponent {
  text = "";
  disabled = false;
  private clickCallback: (() => void | Promise<void>) | null = null;

  setButtonText(value: string): this {
    this.text = value;
    return this;
  }

  setCta(): this {
    return this;
  }

  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }

  onClick(callback: () => void | Promise<void>): this {
    this.clickCallback = callback;
    return this;
  }

  async click(): Promise<void> {
    if (this.disabled) {
      return;
    }

    await this.clickCallback?.();
  }
}

export class MockTextComponent {
  inputEl = {
    type: "text",
    autocomplete: "",
    focus(): void {},
  };
  value = "";
  placeholder = "";
  disabled = false;
  private changeCallback: ((value: string) => void | Promise<void>) | null = null;

  setPlaceholder(value: string): this {
    this.placeholder = value;
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }

  onChange(callback: (value: string) => void | Promise<void>): this {
    this.changeCallback = callback;
    return this;
  }

  async change(value: string): Promise<void> {
    this.value = value;
    await this.changeCallback?.(value);
  }
}

class MockTextAreaComponent extends MockTextComponent {}

export class MockToggleComponent {
  value = false;
  disabled = false;
  private changeCallback: ((value: boolean) => void | Promise<void>) | null = null;

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }

  onChange(callback: (value: boolean) => void | Promise<void>): this {
    this.changeCallback = callback;
    return this;
  }

  async change(value: boolean): Promise<void> {
    if (this.disabled) {
      return;
    }

    this.value = value;
    await this.changeCallback?.(value);
  }
}

export class MockProgressBarComponent {
  value = 0;

  setValue(value: number): this {
    this.value = value;
    return this;
  }
}

export class MockExtraButtonComponent {
  disabled = false;
  icon = "";
  tooltip = "";
  extraSettingsEl = {
    classes: [] as string[],
    addClass: (value: string): void => {
      this.extraSettingsEl.classes.push(value);
    },
  };

  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }

  setIcon(value: string): this {
    this.icon = value;
    return this;
  }

  setTooltip(value: string): this {
    this.tooltip = value;
    return this;
  }
}

export class App {
  private readonly secrets = new Map<string, string>();
  private readonly localStorage = new Map<string, unknown>();

  secretStorage = {
    getSecret: (key: string): string | undefined => this.secrets.get(key),
    setSecret: (key: string, value: string): void => {
      this.secrets.set(key, value);
    },
  };

  loadLocalStorage(key: string): unknown | null {
    return this.localStorage.get(key) ?? null;
  }

  saveLocalStorage(key: string, data: unknown | null): void {
    if (data === null) {
      this.localStorage.delete(key);
      return;
    }

    this.localStorage.set(key, data);
  }
}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: false,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
};

export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {}

export class TFolder extends TAbstractFile {}

export class Plugin {
  app = new App();

  async loadData(): Promise<unknown> {
    return null;
  }

  async saveData(_value: unknown): Promise<void> {}
}

export class Modal {
  containerEl = new MockElement();
  contentEl = new MockElement();

  constructor(public app: unknown) {}

  open(): void {
    this.onOpen();
  }

  close(): void {
    this.onClose();
  }

  onOpen(): void {}

  onClose(): void {}
}

export class PluginSettingTab {
  containerEl = new MockElement();

  constructor(public app: unknown, public plugin: unknown) {}

  hide(): void {}
}

export class Setting {
  descEl = new MockElement();

  constructor(_containerEl: unknown) {}

  setName(value: string): this {
    settingNames.push(value);
    return this;
  }

  setDesc(value: string): this {
    settingDescriptions.push(value);
    return this;
  }

  setHeading(): this {
    return this;
  }

  addButton(callback: (button: MockButtonComponent) => void): this {
    const button = new MockButtonComponent();
    buttonComponents.push(button);
    callback(button);
    return this;
  }

  addExtraButton(callback: (button: MockExtraButtonComponent) => void): this {
    const button = new MockExtraButtonComponent();
    extraButtonComponents.push(button);
    callback(button);
    return this;
  }

  addText(callback: (text: MockTextComponent) => void): this {
    const text = new MockTextComponent();
    textComponents.push(text);
    callback(text);
    return this;
  }

  addTextArea(callback: (text: MockTextAreaComponent) => void): this {
    const text = new MockTextAreaComponent();
    textComponents.push(text);
    callback(text);
    return this;
  }

  addToggle(callback: (toggle: MockToggleComponent) => void): this {
    const toggle = new MockToggleComponent();
    toggleComponents.push(toggle);
    callback(toggle);
    return this;
  }

  addProgressBar(callback: (progressBar: MockProgressBarComponent) => void): this {
    const progressBar = new MockProgressBarComponent();
    progressBarComponents.push(progressBar);
    callback(progressBar);
    return this;
  }
}

export class Notice {
  constructor(_message: string) {}
}

export function setRequestUrlMock(mock: RequestUrlMock): void {
  requestUrlMock = mock;
}

export function getButtonComponents(): MockButtonComponent[] {
  return [...buttonComponents];
}

export function getTextComponents(): MockTextComponent[] {
  return [...textComponents];
}

export function getToggleComponents(): MockToggleComponent[] {
  return [...toggleComponents];
}

export function getProgressBarComponents(): MockProgressBarComponent[] {
  return [...progressBarComponents];
}

export function getExtraButtonComponents(): MockExtraButtonComponent[] {
  return [...extraButtonComponents];
}

export function getCreatedElementTexts(): string[] {
  return [...createdElementTexts];
}

export function getSettingNames(): string[] {
  return [...settingNames];
}

export function getSettingDescriptions(): string[] {
  return [...settingDescriptions];
}

export function resetObsidianMocks(): void {
  requestUrlMock = null;
  buttonComponents.length = 0;
  textComponents.length = 0;
  toggleComponents.length = 0;
  progressBarComponents.length = 0;
  extraButtonComponents.length = 0;
  createdElementTexts.length = 0;
  settingNames.length = 0;
  settingDescriptions.length = 0;
}

export async function requestUrl(input: unknown): Promise<unknown> {
  if (!requestUrlMock) {
    throw new Error("requestUrl mock is not configured");
  }

  return await requestUrlMock(input);
}
