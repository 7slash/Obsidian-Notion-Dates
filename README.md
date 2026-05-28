# Obsidian Notion Dates

Notion-style date pills for Obsidian. Type natural language date mentions like `@today`, `@next wednesday`, or `@may 29`, and the plugin stores them as editable markdown tags while rendering them as compact date pills.

<img width="462" height="430" alt="image" src="https://github.com/user-attachments/assets/6baed16c-ddb6-4cef-900a-33c6a39ef9b2" />


## Features

- Inline date pills in Live Preview and Reading View.
- Notion-style relative labels:
  - `Today`
  - `Tomorrow`
  - `Yesterday`
  - weekday names for dates in the current week
  - `Next Monday` / `Last Friday` for adjacent weeks
  - absolute dates beyond that range
- Smart date insertion from `@` autocomplete.
- Click a date pill to edit it with a date/time picker.
- Optional time support.
- Configurable display format and markdown storage format.
- Automatic rerender when the local date changes, including after midnight or when Obsidian wakes from sleep.

## Usage

Type `@` in the editor to open the date suggestion menu. Choose a suggested date, or keep typing a natural language date.

Examples:

```md
@today
@tomorrow
@now
@next wednesday
@last friday
@may 29
@march 17 2pm
@in 3 days
@2026-05-29
@05/29/2026
```

Inserted dates are stored as plugin date tags:

```md
@[2026-05-29]
@[2026-05-29 14:00]
```

Those tags render as pills, such as `@Today`, `@Next Wednesday`, or `@May 29, 2026`, depending on your settings and the current date.

## Settings

Open Obsidian Settings, then go to **Community plugins > Obsidian Notion Dates**.

### Date Label Format

Controls how pills are displayed:

- Notion-style relative
- Short date
- Month day, year
- Weekday, month day, year
- Numeric date
- ISO date

### Time Format

Controls times shown in pills:

- 12-hour
- 24-hour

### Markdown Date Format

Controls what is written inside `@[...]` tags:

- `YYYY-MM-DD`
- `YYYY/MM/DD`
- `MM/DD/YYYY`
- `Month D, YYYY`
- Custom

The default is `YYYY-MM-DD` because it is portable and unambiguous.

### Custom Markdown Format

When Markdown Date Format is set to **Custom**, enter a format using these tokens:

- `YYYY`
- `YY`
- `MM`
- `M`
- `DD`
- `D`

Examples:

```text
YYYY-MM-DD
YYYY-DD-MM
MM/DD/YYYY
D-M-YY
```

Custom formats must include a year token, a month token, and a day token. If the custom format is invalid, the plugin falls back to `YYYY-MM-DD`.

### Week Starts On

Controls how relative labels such as `Tuesday`, `Next Monday`, and `Last Friday` are calculated.

## Installation

For local installation:

1. Build the plugin.
2. Copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<your vault>/.obsidian/plugins/notion-dates/
```

3. Reload Obsidian.
4. Enable **Obsidian Notion Dates** in Community Plugins.

## Development

Install dependencies:

```sh
npm install
```

Build:

```sh
npm run build
```

Development watch mode:

```sh
npm run dev
```

To auto-copy builds into a vault plugin folder, set:

```sh
OBSIDIAN_VAULT_PLUGIN_PATH="/path/to/vault/.obsidian/plugins/notion-dates" npm run dev
```

## Privacy and Security

This plugin runs locally inside Obsidian. It does not make network requests or send note content to external services.

When editing a pill in Reading View, the plugin updates the source file that rendered the clicked date tag.

## Author

7slash
