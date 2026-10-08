## Notion Dates 1.2.0

A new date/time picker and quick minute offsets from `@now`.

### Date/time picker

- Compact calendar that follows your Obsidian theme.
- Today, Tomorrow, and In a week shortcuts, plus natural-language date entry.
- Inline hour and minute fields with optional time, a Now button, and your preferred 12-hour or 24-hour format.
- Calendar keyboard navigation and your configured week start.
- Clear validation for invalid dates and times.
- Edit pills in Live Preview and Reading View while preserving your markdown storage format.

### Minute offsets

- `@now-5`: five minutes ago.
- `@now15`: fifteen minutes from now.
- `@now+10`: ten minutes from now.

Select the suggestion or press Enter to insert the calculated date and time.
Offsets work across midnight and daylight-saving transitions. Inserted timestamps
stay fixed; existing date tags and settings continue to work.

### Updating manually

Copy `main.js`, `manifest.json`, and `styles.css` from this release into
`<vault>/.obsidian/plugins/notion-dates/`, then turn Notion Dates off and back on
in Community plugins. The Reload plugins button only refreshes the plugin list.
