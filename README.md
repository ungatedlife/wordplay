# ✎ Wordplay

An editing playground for Obsidian. After Jason Fried's Write_On: *alternative control, not version control.*
Try things. Nothing is final until you say so, and ⌘Z takes back anything you do.

| | what it does |
|---|---|
| **Edit mode** | ⌥⌘E. Turns the playground on: underlines, ghosts, the passes chip. Off, the page is clean for writing |
| **Alternatives** | Select a word, sentence or paragraph (or just sit in a word), right-click. Write your own, or ask the AI |
| **Cycling** | ⌥← / ⌥→ inside a choice swaps the alternatives in on the page. A lower tone means you're back on the original |
| **Explode** | Land on one you hate while cycling and hit ⌫: it bursts, and leaves the list. ⌘Z brings it back |
| **Ghost** | ⌃/ dims a stretch to 20%, so you can read the page as if it weren't there |
| **Scratchpad** | ⌃⇧X stashes a bit out of the draft into the note's scratchpad. Out of sight, never gone |
| **Passes** | ⌃⇧L, or the PASSES chip at the bottom. Typos, weakest sentences, long ones, tangles, tone, hedges, over-explaining, and trims from 10% to half |

## The pens

Every spot with alternatives gets a slightly wobbly underline, like an editor's pen:

- **faint** when it's showing your original
- **orange** when it's showing one of yours
- **purple** when it's showing one of the AI's

A sentence's line sits a little lower than a word's, so a word inside a sentence keeps its own.
A paragraph gets a stroke down the margin instead. In the panel, ▪ is you and the little robot is the AI.

## The panel

Right sidebar. **Word · Sentence · Paragraph** pick how much of the text around the cursor you're playing with.

- ↑ ↓ swaps each alternative in, live, on the page
- ⌫ explodes the one you're on (never the original)
- type in the box and ↵ to add your own. Shift-↵ for a new line
- `??` in the box asks the AI. `?? weirder`, `?? shorter`, `?? more like a text message` steer it
- ↵ or esc takes you back to the page. ⌘Z works from here too

**In this note** lists every spot with alternatives, to jump around. **Settle** keeps what's showing and
lets the rest go. The **Scratchpad** tab shows what you've stashed from this note: put it back, drag it in, copy it, or toss it.

## Passes

Same rules for all of them: the AI points, you decide.

- **Marks** (weakest, long, convoluted, tone, hedges, over-explaining): hover for why, click for what to do
  (try alternatives, ghost it, fine as is). *Walk through* takes them one at a time: ← → to move.
- **Fix punctuation and typos**: the old text is struck through, the fix sits beside it. *Fix all* asks *are you sure??* first.
- **Trims**: faded words would go. Click one to keep it. *Make the cuts* asks *are you sure??*, then they explode.
  *Walk through* says why each cut is there: ↵ cuts it, K keeps it.

Select something first and the pass only reads that. Make your own passes in settings.

## Two brains

Bring your own OpenRouter key and pick two models:

- **Quick (dumb mode)**: word swaps, typos, the passes that mostly count. Default `anthropic/claude-haiku-5.5`, a fraction of a cent a go
- **Smart (smarty pants mode)**: anything a sentence or longer, trims, the judgment calls. Default `anthropic/claude-sonnet-5.5`, about a cent (a whole-note trim, a few cents)

Settings → Wordplay → *Which brain for what* moves any job between them. *About your writing* goes with every ask.
The key lives in Obsidian's keychain (Settings → Keychain), never in a plugin file.

## With Lock In and Robsidian

Edit mode and writing are different rooms. While Lock In's **fuse** is lit, edit mode steps out and won't come back
until the session ends: stopping to fiddle would burn the draft. Lock In's locks are fine; edit with the note locked.
Robsidian's writer mode hides the status bar, but the passes chip stays.

Scratchpads live in `Scratchpads/` with no status, so the site never publishes them.

## Keys

| | |
|---|---|
| ⌥⌘E | edit mode on / off |
| ⌃⇧A | alternatives for the selection (write your own) |
| ⌃⇧G | AI alternatives for the selection |
| ⌥← ⌥→ | cycle, inside a choice (Settings can make it ⌃⌥) |
| ⌫ | explode, while cycling |
| ⌃/ | ghost it, or bring it back |
| ⌃⇧X | stash in the scratchpad |
| ⌃⇧L | passes |
| ⌃. | the edit menu, without the mouse |

Change any of them in Settings → Hotkeys (search "Wordplay").

## Build, test, play

```bash
npm install && npm run build   # main.js
npm test                       # the engine: swaps, nesting, explode + undo, saving
npm run try                    # a sandbox Obsidian with a pretend AI; your real one is untouched
```

The repo is symlinked into the vault, like Lock In:

```
The Conversation/.obsidian/plugins/wordplay → Rob HQ/Code/Obsidian/wordplay
```

Your choices and ghosts are saved in `data.json` here (never in git), keyed by note, and find their words again if
the note changes on disk. Nothing is ever written into the note itself.

## Thanks

To Jason Fried for Write_On and the video, and for the two tones and the wobbly lines.
