import { FuzzySuggestModal, Notice, PluginSettingTab, SecretComponent, Setting, requestUrl, type App } from 'obsidian';
import type WordplayPlugin from './main';
import { chat, type Brain } from './ai';
import { newId } from './items';
import type { BrainSlot } from './passes';

export interface CustomPass { id: string; name: string; instruction: string; target: 'sentences' | 'spans'; brain: Brain }

export interface WordplaySettings {
  /** the name of the OpenRouter key in Obsidian's keychain (the key itself never sits in data.json) */
  keySecret: string;
  quickModel: string;
  smartModel: string;
  baseUrl: string;
  brains: Record<BrainSlot, Brain>;
  count: number;
  voice: string;
  sounds: boolean;
  explosions: boolean;
  volume: number;
  ghostOpacity: number;
  cycleKeys: 'alt' | 'ctrl-alt' | 'ctrl';
  scratchFolder: string;
  customPasses: CustomPass[];
}

export const DEFAULT_SETTINGS: WordplaySettings = {
  keySecret: '',
  quickModel: 'anthropic/claude-haiku-5.5',
  smartModel: 'anthropic/claude-sonnet-5.5',
  baseUrl: 'https://openrouter.ai/api/v1',
  brains: { words: 'quick', rewrites: 'smart', typos: 'quick', mechanical: 'quick', judgment: 'smart', trim: 'smart' },
  count: 5,
  voice: "Plain, warm, alive, a little irreverent. Honest over polished. My failure mode is over-explaining until the live idea is buried, so protect the spark: cut explanation, don't add it.",
  sounds: true,
  explosions: true,
  volume: 0.5,
  ghostOpacity: 0.2,
  cycleKeys: 'alt',
  scratchFolder: 'Scratchpads',
  customPasses: [],
};

const SLOTS: Array<[BrainSlot, string, string]> = [
  ['words', 'Swapping a word', 'Alternatives for a word or a short phrase'],
  ['rewrites', 'Rewriting a sentence or more', 'Alternatives for sentences, phrases, paragraphs'],
  ['typos', 'Typos and punctuation', 'The fix pass'],
  ['mechanical', 'Long sentences, hedges and filler', 'The passes that mostly count and spot'],
  ['judgment', 'Weakest, convoluted, tone, over-explaining', 'The passes that take taste (and your own passes, unless you say otherwise)'],
  ['trim', 'Trims', 'Slight trim through cut in half'],
];

export class WordplaySettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: WordplayPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();
    containerEl.addClass('wp-settings');

    new Setting(containerEl).setName('The AI').setHeading();
    new Setting(containerEl)
      .setName('OpenRouter key')
      .setDesc("Kept in Obsidian's keychain, not in this plugin's settings file. Get one at openrouter.ai/keys.")
      .addComponent((el) => new SecretComponent(this.app, el).setValue(s.keySecret).onChange(async (v) => { s.keySecret = v ?? ''; await save(); }));

    const model = (name: string, desc: string, key: 'quickModel' | 'smartModel') => {
      let text: { setValue(v: string): unknown } | null = null;
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => { text = t; t.setPlaceholder('provider/model').setValue(s[key]).onChange(async (v) => { s[key] = v.trim(); await save(); }); })
        .addButton((b) => b.setButtonText('Browse').onClick(() => {
          new ModelPicker(this.app, this.plugin, async (id) => { s[key] = id; text?.setValue(id); await save(); }).open();
        }));
    };
    model('Quick model (dumb mode)', 'Word swaps, typos, the mechanical passes. Cheap and fast.', 'quickModel');
    model('Smart model (smarty pants mode)', 'Anything a sentence or longer, trims, the judgment calls.', 'smartModel');

    new Setting(containerEl).setName('Which brain for what').setDesc('Quick or smart, job by job.').setHeading();
    for (const [slot, name, desc] of SLOTS) {
      new Setting(containerEl).setName(name).setDesc(desc).addDropdown((d) => d
        .addOptions({ quick: 'Quick', smart: 'Smart' })
        .setValue(s.brains[slot])
        .onChange(async (v) => { s.brains[slot] = v as Brain; await save(); }));
    }

    new Setting(containerEl)
      .setName('How many ideas')
      .setDesc('AI alternatives per ask.')
      .addSlider((sl) => sl.setLimits(3, 10, 1).setValue(s.count).setDynamicTooltip().onChange(async (v) => { s.count = v; await save(); }));

    new Setting(containerEl)
      .setName('About your writing')
      .setDesc('Goes with every ask, so the ideas sound like you.')
      .addTextArea((t) => {
        t.setValue(s.voice).onChange(async (v) => { s.voice = v; await save(); });
        t.inputEl.rows = 4;
        t.inputEl.addClass('wp-settings-wide');
      });

    new Setting(containerEl)
      .setName('Try it')
      .setDesc('One tiny ask to each model, to check the key and the names.')
      .addButton((b) => b.setButtonText('Say hi').onClick(async () => {
        b.setDisabled(true);
        for (const brain of ['quick', 'smart'] as const) {
          try {
            const reply = await chat(this.plugin, brain, [{ role: 'user', content: 'Say hi to a writer in four words or fewer.' }], { maxTokens: 30, temperature: 0.9 });
            new Notice(`${brain}: ${reply.trim()}`, 5000);
          } catch (e) { this.plugin.complain(e); }
        }
        b.setDisabled(false);
      }));

    new Setting(containerEl).setName('The feel').setHeading();
    new Setting(containerEl).setName('Sounds').setDesc('A tick as you cycle, a lower one when you land back on the original, a poof when one explodes.')
      .addToggle((t) => t.setValue(s.sounds).onChange(async (v) => { s.sounds = v; await save(); }));
    new Setting(containerEl).setName('Volume')
      .addSlider((sl) => sl.setLimits(0.1, 1, 0.1).setValue(s.volume).setDynamicTooltip().onChange(async (v) => { s.volume = v; await save(); }));
    new Setting(containerEl).setName('Explosions').setDesc('Options you delete burst; stashed bits fly off to the scratchpad.')
      .addToggle((t) => t.setValue(s.explosions).onChange(async (v) => { s.explosions = v; await save(); }));
    new Setting(containerEl).setName('Ghost dimness').setDesc('How faint a ghost is.')
      .addSlider((sl) => sl.setLimits(0.05, 0.5, 0.05).setValue(s.ghostOpacity).setDynamicTooltip().onChange(async (v) => { s.ghostOpacity = v; await save(); }));
    new Setting(containerEl).setName('Cycle keys').setDesc('Inside a choice, in edit mode. Outside one, the keys do what they always do.')
      .addDropdown((d) => d
        .addOptions({ alt: '⌥ ← / →', 'ctrl-alt': '⌃⌥ ← / →', ctrl: '⌃ ← / → (macOS may take these for Spaces)' })
        .setValue(s.cycleKeys)
        .onChange(async (v) => { s.cycleKeys = v as WordplaySettings['cycleKeys']; await save(); }));

    new Setting(containerEl).setName('Scratchpads').setHeading();
    new Setting(containerEl).setName('Folder').setDesc("Where each note's scratchpad lives. They have no status, so they never ship.")
      .addText((t) => t.setPlaceholder('Scratchpads').setValue(s.scratchFolder).onChange(async (v) => { s.scratchFolder = v.trim() || 'Scratchpads'; await save(); }));

    new Setting(containerEl).setName('Your own passes').setDesc('They show up under the built-in ones.').setHeading();
    for (const pass of s.customPasses) {
      const wrap = containerEl.createDiv({ cls: 'wp-custom-pass' });
      new Setting(wrap).setName('Name')
        .addText((t) => t.setPlaceholder('Mark the boring bits').setValue(pass.name).onChange(async (v) => { pass.name = v; await save(); }))
        .addExtraButton((b) => b.setIcon('trash').setTooltip('Remove this pass').onClick(async () => {
          s.customPasses = s.customPasses.filter((p) => p !== pass);
          await save();
          this.display();
        }));
      new Setting(wrap).setName('What to look for')
        .addTextArea((t) => { t.setPlaceholder('Mark sentences that…').setValue(pass.instruction).onChange(async (v) => { pass.instruction = v; await save(); }); t.inputEl.rows = 3; t.inputEl.addClass('wp-settings-wide'); });
      new Setting(wrap).setName('Marks')
        .addDropdown((d) => d.addOptions({ sentences: 'Whole sentences', spans: 'Words and phrases' }).setValue(pass.target).onChange(async (v) => { pass.target = v as CustomPass['target']; await save(); }))
        .addDropdown((d) => d.addOptions({ quick: 'Quick brain', smart: 'Smart brain' }).setValue(pass.brain).onChange(async (v) => { pass.brain = v as Brain; await save(); }));
    }
    new Setting(containerEl).addButton((b) => b.setButtonText('Add a pass').onClick(async () => {
      s.customPasses.push({ id: newId('p'), name: '', instruction: '', target: 'sentences', brain: 'smart' });
      await save();
      this.display();
    }));

    new Setting(containerEl).setName('Under the hood').setHeading();
    new Setting(containerEl).setName('API address').setDesc('OpenRouter, or any OpenAI-style endpoint.')
      .addText((t) => t.setValue(s.baseUrl).onChange(async (v) => { s.baseUrl = v.trim() || DEFAULT_SETTINGS.baseUrl; await save(); }));
  }
}

interface ModelRow { id: string; label: string }

/** OpenRouter's model list, with what each costs per million tokens in and out */
class ModelPicker extends FuzzySuggestModal<ModelRow> {
  private rows: ModelRow[] = [];

  constructor(app: App, private plugin: WordplayPlugin, private choose: (id: string) => void) {
    super(app);
    this.setPlaceholder('loading models…');
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const base = (this.plugin.settings.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, '');
      const res = await requestUrl({ url: `${base}/models` });
      const data = (res.json?.data ?? []) as Array<{ id: string; name?: string; pricing?: { prompt?: string; completion?: string } }>;
      const price = (p?: string) => (p && !isNaN(Number(p)) ? `$${(Number(p) * 1e6).toFixed(2)}` : '?');
      this.rows = data.map((m) => ({ id: m.id, label: `${m.id}   ${price(m.pricing?.prompt)} in · ${price(m.pricing?.completion)} out` }));
      this.setPlaceholder('pick a model (prices per million tokens)');
      // nudge the list to redraw now that it's here
      this.inputEl.dispatchEvent(new Event('input'));
    } catch (e) {
      this.setPlaceholder("couldn't load the list. type a model id in settings instead.");
    }
  }

  getItems(): ModelRow[] { return this.rows; }
  getItemText(row: ModelRow): string { return row.label; }
  onChooseItem(row: ModelRow): void { this.choose(row.id); }
}
