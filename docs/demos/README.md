# Demo GIF

The terminal recording in the project README, rendered with
[charmbracelet/vhs](https://github.com/charmbracelet/vhs) from `claude.tape`.

It replays a baked-in fixture (`fixtures/claude-session.txt`) of what an MCP client like
Claude shows when it calls `abrp_plan_route` — a plain-English request in, a planned trip with
charging stops out. It's illustrative and needs no API key (the real `/plan` endpoint is billed).

## Regenerate

```bash
brew install vhs            # or: go install github.com/charmbracelet/vhs@latest
vhs docs/demos/claude.tape
```

Edit `fixtures/claude-session.txt` to change what's shown.
