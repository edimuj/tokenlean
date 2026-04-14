# Language Support

Code analysis tools are JS/TS-first, but many work across languages. Git-based and search tools work with any language.

|                 | JS/TS | Python | Go | Rust | Ruby | Elixir/Lua | Other |
|-----------------|:-----:|:------:|:--:|:----:|:----:|:----------:|:-----:|
| `tl symbols`    |   ✓   |   ✓    | ✓  |  ✓   |  ✓   |     ◐      |   ◐   |
| `tl snippet`    |   ✓   |   ✓    | ✓  |  ✓   |  ✓   |     ✓      |   ◐   |
| `tl exports`    |   ✓   |   ✓    | ✓  |  ◐   |  ◐   |     ◐      |   ◐   |
| `tl deps`       |   ✓   |   ✓    | ✓  |  ◐   |  ◐   |     ◐      |   ◐   |
| `tl impact`     |   ✓   |   ✓    | ✓  |  -   |  -   |     -      |   -   |
| `tl complexity` |   ✓   |   ✓    | ✓  |  -   |  -   |     -      |   -   |
| `tl flow`       |   ✓   |   ◐    | ◐  |  -   |  -   |     -      |   -   |
| `tl docs`       |   ✓   |   ◐    | -  |  -   |  -   |     -      |   -   |
| `tl types`      |   ✓   |   -    | -  |  -   |  -   |     -      |   -   |
| `tl component`  |   ✓   |   -    | -  |  -   |  -   |     -      |   -   |
| `tl style`      |   ✓   |   -    | -  |  -   |  -   |     -      |   -   |
| `tl routes`     |   ✓   |   ◐    | -  |  -   |  -   |     -      |   -   |

**✓** full support &nbsp; **◐** partial (regex-based patterns, may miss language-specific constructs) &nbsp; **-** not supported

Tools not listed (`tl structure`, `tl search`, `tl diff`, `tl todo`, `tl secrets`, `tl guard`, `tl blame`, `tl history`, `tl hotspots`, `tl example`, `tl env`, `tl run`, `tl tail`, etc.) are language-agnostic and work with any codebase.
