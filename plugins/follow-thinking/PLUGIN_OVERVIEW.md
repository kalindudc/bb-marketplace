Watch an agent reason without clicking each thinking row open and scrolling inside it while the text streams.

## What you get

- The live **Thinking…** row at the bottom of a running thread opens by itself and stays scrolled to its newest line.
- Finished **Thought** rows open when they appear, including the ones inside an activity group once you open that group.
- Scroll up inside a thinking block to read earlier text and it stops following; scroll back to the bottom and it follows again.
- A block you collapse stays collapsed.
- A brain button in the thread header turns the plugin on or off, and so do the **Follow thinking** item in any thread's actions menu (the one phones use, since their header leaves the button out) and the command **Follow Thinking: Toggle auto-expand and auto-scroll of thinking** in the command palette. Turning it off collapses the blocks it opened and leaves the ones you opened.

## How it works

The plugin runs in the bb window and works on the timeline bb already draws. It needs no account, settings or server state. The on/off choice is saved on each device and shared by every bb window there.

## Limits

bb has no plugin interface for timeline rows, so the plugin recognises thinking blocks by the markup that bb 0.46 draws. If a bb update changes that markup, the plugin stops doing anything until it is updated; the timeline itself keeps working.
