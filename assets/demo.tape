# tokenlean demo
Output assets/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 900
Set Height 520
Set Padding 16
Set Theme { "name": "tokenlean", "black": "#1e1e2e", "red": "#f38ba8", "green": "#a6e3a1", "yellow": "#f9e2af", "blue": "#89b4fa", "magenta": "#cba6f7", "cyan": "#94e2d5", "white": "#cdd6f4", "brightBlack": "#585b70", "brightRed": "#f38ba8", "brightGreen": "#a6e3a1", "brightYellow": "#f9e2af", "brightBlue": "#89b4fa", "brightMagenta": "#cba6f7", "brightCyan": "#94e2d5", "brightWhite": "#f5f5f5", "background": "#1e1e2e", "foreground": "#cdd6f4", "cursor": "#f5e0dc", "selection": "#45475a" }
Set CursorBlink false

Sleep 500ms

# Show project structure
Type "tl-structure src/"
Sleep 300ms
Enter
Sleep 2s

# Now show symbols for a file
Type "tl-symbols src/traverse.mjs"
Sleep 300ms
Enter
Sleep 3s

# Show exports
Type "tl-exports src/output.mjs"
Sleep 300ms
Enter
Sleep 3s

Sleep 1s
