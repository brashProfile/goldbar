<p align="center">
  <img src="assets/icon.svg" width="140" alt="goldbar icon: a smiling gold bar">
</p>

<h1 align="center">goldbar</h1>

<p align="center">Your Claude usage limits, as a little bar of gold above the prompt.</p>

<p align="center">
  <img src="assets/band-dark.svg" alt="goldbar in dark mode, four rounded islands: 2 background tasks running, 5-hour 34%, Weekly 62% with 2d 9h until reset, Fable 41%">
</p>

goldbar is a [Claude Code](https://claude.com/claude-code) mod. It sits in the band directly above the prompt and shows how much of each usage limit you have spent:

- **Background tasks**: at the far left, a gold ring that spins with a count while background shells, subagents or monitors are running, and sits still at 0 when nothing is.
- **5-hour**: the rolling session window.
- **Weekly**: the all-models weekly limit, with `↻` and the time until it resets.
- **Fable**: one model's own weekly limit (Fable by default; any model `/usage` lists).

Each group sits in its own rounded island, with the page showing between them and the contents centered. The pills fill left to right through deepening shades of gold. While Claude is working on a turn, a swell runs along the pills from left to right, so you can see at a glance that it is busy.

<p align="center">
  <img src="assets/band-light.svg" alt="goldbar in light mode, with no background tasks running">
</p>

## Fits any width

The band reshapes itself as it narrows, and keeps the weekly bar and the background-task spinner the longest:

<p align="center">
  <img src="assets/band-narrow.svg" alt="The band at five narrower widths: side pills squish into beads, roll up into rings, then step aside; the weekly bar loses its countdown, squishes, and finally rolls up into a ring">
</p>

Each change of shape lands with a little bounce.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install goldbar --marketplace brashProfile/goldbar
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). The settings screen that follows can be skipped: every setting has a default.

From a shell:

```bash
claude plugin install goldbar --marketplace brashProfile/goldbar
```

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `brashProfile/goldbar`, then **Add plugin**.

## Settings

Every color, label and count is a setting. In a terminal session run `/plugin`, open goldbar and choose **Configure**, or set them in `~/.claude/settings.json` (a running session picks up changes on `/reload-plugins`):

```json
{
  "pluginConfigs": {
    "goldbar@goldbar": {
      "options": {
        "weeklyPills": 7,
        "goldStart": "#f2c200",
        "goldEnd": "#b07300",
        "modelName": "Opus"
      }
    }
  }
}
```

| Setting | Default | What it does |
|---|---|---|
| `showBackground` | `true` | Spinner and count of running background tasks |
| `showSession` | `true` | The 5-hour bar |
| `showWeekly` | `true` | The weekly bar |
| `showModel` | `true` | The model bar |
| `sessionLabel` | `5-hour` | Label for the 5-hour bar |
| `weeklyLabel` | `Weekly` | Label for the weekly bar |
| `modelName` | `Fable` | Which model's weekly limit the third bar shows |
| `sessionPills` | `5` | Pills in the 5-hour bar (1–14) |
| `weeklyPills` | `5` | Pills in the weekly bar (1–14) |
| `modelPills` | `5` | Pills in the model bar (1–14) |
| `goldStart` | `#d9a400` | Color of the first pill |
| `goldEnd` | `#6e4700` | Color of the last pill; the pills between shade from one to the other |
| `labelColor` | `#805500` | Bar labels |
| `valueColor` | `#b88400` | Percentages, reset time and task count |
| `dividerColor` | `#1b1b1b` | Lines between the bars |
| `trackColor` | `#8b949e` | Unfilled pills (drawn faint) |
| `showResetTime` | `true` | The `↻` countdown to the weekly reset |
| `pulse` | `true` | Pills swell left to right while Claude works |
| `pulseSeconds` | `1.6` | Seconds for one swell to cross a bar |
| `modelRefreshMinutes` | `2` | How often the model bar's figure is fetched, at most |
| `islands` | `true` | Each group is its own rounded island with the page showing between them; off gives one flat bar with divider lines |
| `gapColor` | `#191919` | Color painted between the islands; set it to the app's page background |
| `islandGap` | `8` | Pixels between islands |
| `bandHeight` | `40` | Height of the band in pixels; the islands' round ends are cut to it |
| `bandPadding` | `8` | Pixels between the band's edge and its content, left and right |
| `columnPixels` | `8` | How wide one text column is taken to be when fitting the bars; raise it if they shrink too late |
| `bounce` | `true` | Pills and rings bounce when they change shape |

The islands are made by painting the page's color over the band between the groups, so `gapColor` has to match the page. The default suits dark mode; in light mode set it to the light page color (`#faf9f5` in the pictures here). If the islands' ends look clipped or leave a sliver of the band showing, adjust `bandHeight` and `bandPadding`, or set `islands` to `false` for one flat bar with divider lines.

## What you need

- A Claude subscription (Pro, Max, Team or Enterprise). Usage limits are only reported for subscription sign-ins; with an API key the band stays empty.
- Claude Code with mod support (the `AbovePrompt` band). The islands, pills and rings are drawn in the desktop app; a terminal session shows the same figures as a text gauge.

## How it works

- The 5-hour and weekly figures come from the rate-limit readings Claude Code already receives with each response, so they update after every turn.
- The Fable figure comes from the same usage endpoint the `/usage` screen reads, called with your own session's sign-in at most every two minutes. Nothing is sent anywhere else.
- Before your first message in a new session there is no fresh reading yet, so the weekly bar shows the last one it saw, dimmed, with "(last seen … ago)".
- Background tasks are counted when the call that starts them returns, and cleared when their completion notice arrives (a task with no notice drops off after 6 hours).
- The band fits itself to any width. As it narrows, an island's inner padding tightens first; then the 5-hour and model pills squish into round beads, roll up into small ring gauges, and step aside; the weekly bar keeps its full size and countdown the longest, then squishes and finally rolls up into a ring too.
- Collapse the band with the `[-]` beside it, or ctrl+x ctrl+a.

## Development

```bash
claude plugin validate .
claude plugin test .
```

Run it from a working copy with `claude --plugin-dir /path/to/goldbar`.

## License

MIT
