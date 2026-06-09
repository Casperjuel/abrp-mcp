# VHS tape — a Claude-style thread planning an EV family road trip.
# Light "paper" theme + window bar to evoke Claude. Replays a baked-in
# conversation (fixtures/claude-thread.sh), so it needs no API key.
#
#   vhs docs/demos/claude.tape

Output docs/demos/claude.gif

Set Shell bash
Set FontSize 15
Set Width 1080
Set Height 1120
Set Padding 30
Set Margin 40
Set MarginFill "#E8E5DC"
Set BorderRadius 12
Set WindowBar Colorful
Set TypingSpeed 1ms
Set Theme { "name": "claude", "background": "#F7F6F1", "foreground": "#2D2A26", "cursor": "#D97757", "selection": "#E7E4DA", "black": "#2D2A26", "red": "#C2410C", "green": "#3F6212", "yellow": "#A16207", "blue": "#1D4ED8", "magenta": "#A21CAF", "cyan": "#0E7490", "white": "#2D2A26", "brightBlack": "#8A7F70", "brightRed": "#D97757", "brightGreen": "#3F6212", "brightYellow": "#A16207", "brightBlue": "#1D4ED8", "brightMagenta": "#A21CAF", "brightCyan": "#0E7490", "brightWhite": "#2D2A26" }

Hide
Type 'export PS1=""'
Enter
Type 'clear; bash docs/demos/fixtures/claude-thread.sh'
Enter
Sleep 500ms
Show
Sleep 10s
