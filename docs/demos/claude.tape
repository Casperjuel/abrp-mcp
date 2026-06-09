# VHS tape — what abrp-mcp looks like from an MCP client (Claude).
# The fixture has the whole session (prompt + tool call + answer) baked in,
# so the GIF is deterministic and needs no API key.
#
#   vhs docs/demos/claude.tape

Output docs/demos/claude.gif

Set Shell bash
Set FontSize 14
Set Width 1120
Set Height 680
Set Theme "Catppuccin Mocha"
Set Padding 24
Set BorderRadius 10

Hide
Type 'export PS1=""'
Enter
Type 'OUT=$(cat docs/demos/fixtures/claude-session.txt)'
Enter
Type 'clear; printf "%s\n" "$OUT"'
Enter
Sleep 400ms
Show
Sleep 9s
