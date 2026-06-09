# Demo GIF

The terminal recording in the project README, rendered with
[charmbracelet/vhs](https://github.com/charmbracelet/vhs) from `claude.tape`.

It replays a baked-in Claude-style conversation (`fixtures/claude-thread.sh`) in a light "paper"
theme with a window bar, so it reads like Claude planning an EV family road trip. It needs no API
key — the thread is pre-written; the ABRP link in it is a real saved plan.

## Regenerate

```bash
brew install vhs            # or: go install github.com/charmbracelet/vhs@latest
vhs docs/demos/claude.tape
```

Edit `fixtures/claude-thread.sh` to change the conversation, then re-render.
