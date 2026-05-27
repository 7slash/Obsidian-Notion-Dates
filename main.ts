import {
	Plugin,
	Editor,
	MarkdownView,
	Modal,
	App,
	PluginSettingTab,
	Setting,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	EditorPosition,
	TFile
} from 'obsidian';

import {
	Decoration,
	DecorationSet,
	EditorView,
	WidgetType
} from '@codemirror/view';

import {
	EditorState,
	Range,
	StateField,
	Transaction
} from '@codemirror/state';

// Global DATE_REGEX used throughout the plugin
const DATE_REGEX = /@\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?\]/g;

type DateFormatKey = "relative" | "short" | "medium" | "long" | "iso" | "numeric";
type TimeFormatKey = "12-hour" | "24-hour";
type WeekStartsOnKey = "sunday" | "monday";

interface NotionDatePluginSettings {
	dateFormat: DateFormatKey;
	timeFormat: TimeFormatKey;
	weekStartsOn: WeekStartsOnKey;
}

const DEFAULT_SETTINGS: NotionDatePluginSettings = {
	dateFormat: "relative",
	timeFormat: "12-hour",
	weekStartsOn: "sunday"
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const MONTHS: Record<string, number> = {
	jan: 0,
	january: 0,
	feb: 1,
	february: 1,
	mar: 2,
	march: 2,
	apr: 3,
	april: 3,
	may: 4,
	jun: 5,
	june: 5,
	jul: 6,
	july: 6,
	aug: 7,
	august: 7,
	sep: 8,
	sept: 8,
	september: 8,
	oct: 9,
	october: 9,
	nov: 10,
	november: 10,
	dec: 11,
	december: 11
};

const WEEKDAY_INDEX: Record<string, number> = WEEKDAYS.reduce((acc, weekday, index) => {
	acc[weekday.toLowerCase()] = index;
	acc[weekday.slice(0, 3).toLowerCase()] = index;
	return acc;
}, {} as Record<string, number>);

interface ParsedSmartDate {
	date: Date;
	timeStr?: string;
}

function parseLocalDate(dateStr: string): Date {
	const [year, month, day] = dateStr.split("-").map((part) => parseInt(part, 10));
	return new Date(year, month - 1, day);
}

function formatDateValue(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function startOfToday(): Date {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	return today;
}

function daysBetween(targetDate: Date, baseDate: Date): number {
	const target = new Date(targetDate);
	target.setHours(0, 0, 0, 0);

	const base = new Date(baseDate);
	base.setHours(0, 0, 0, 0);

	return Math.round((target.getTime() - base.getTime()) / (1000 * 60 * 60 * 24));
}

function addDays(date: Date, days: number): Date {
	const result = new Date(date);
	result.setDate(result.getDate() + days);
	return result;
}

function addMonths(date: Date, months: number): Date {
	const result = new Date(date);
	result.setMonth(result.getMonth() + months);
	return result;
}

function addYears(date: Date, years: number): Date {
	const result = new Date(date);
	result.setFullYear(result.getFullYear() + years);
	return result;
}

function getWeekStart(date: Date, weekStartsOn: WeekStartsOnKey): Date {
	const start = new Date(date);
	start.setHours(0, 0, 0, 0);
	const firstDay = weekStartsOn === "monday" ? 1 : 0;
	const diff = (start.getDay() - firstDay + 7) % 7;
	start.setDate(start.getDate() - diff);
	return start;
}

function isSameWeek(a: Date, b: Date, weekStartsOn: WeekStartsOnKey): boolean {
	return getWeekStart(a, weekStartsOn).getTime() === getWeekStart(b, weekStartsOn).getTime();
}

function isAdjacentWeek(targetDate: Date, baseDate: Date, weekStartsOn: WeekStartsOnKey, direction: "next" | "last"): boolean {
	const targetWeek = getWeekStart(targetDate, weekStartsOn);
	const baseWeek = getWeekStart(baseDate, weekStartsOn);
	const offset = direction === "next" ? 7 : -7;
	baseWeek.setDate(baseWeek.getDate() + offset);
	return targetWeek.getTime() === baseWeek.getTime();
}

function formatAbsoluteDate(date: Date, format: DateFormatKey): string {
	if (format === "iso") {
		return formatDateValue(date);
	}

	if (format === "numeric") {
		return date.toLocaleDateString(undefined, {
			month: "2-digit",
			day: "2-digit",
			year: "numeric"
		});
	}

	if (format === "long") {
		return date.toLocaleDateString(undefined, {
			weekday: "long",
			month: "long",
			day: "numeric",
			year: "numeric"
		});
	}

	if (format === "medium") {
		return date.toLocaleDateString(undefined, {
			month: "long",
			day: "numeric",
			year: "numeric"
		});
	}

	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric"
	});
}

function getNotionStyleRelativeDate(date: Date, settings: NotionDatePluginSettings): string {
	const today = startOfToday();
	const diffDays = daysBetween(date, today);

	if (diffDays === 0) return "Today";
	if (diffDays === 1) return "Tomorrow";
	if (diffDays === -1) return "Yesterday";

	if (Math.abs(diffDays) <= 6 && isSameWeek(date, today, settings.weekStartsOn)) {
		return WEEKDAYS[date.getDay()];
	}

	if (diffDays > 0 && diffDays <= 13 && isAdjacentWeek(date, today, settings.weekStartsOn, "next")) {
		return `Next ${WEEKDAYS[date.getDay()]}`;
	}

	if (diffDays < 0 && diffDays >= -13 && isAdjacentWeek(date, today, settings.weekStartsOn, "last")) {
		return `Last ${WEEKDAYS[date.getDay()]}`;
	}

	return formatAbsoluteDate(date, "short");
}

function formatTimeValue(timeStr: string, settings: NotionDatePluginSettings): string {
	if (settings.timeFormat === "24-hour") {
		return timeStr;
	}

	const [hoursStr, minutesStr] = timeStr.split(":");
	const hours = parseInt(hoursStr, 10);
	const ampm = hours >= 12 ? "pm" : "am";
	const hours12 = hours % 12 || 12;
	return `${hours12}:${minutesStr}${ampm}`;
}

/**
 * Formats YYYY-MM-DD and optional HH:mm into a friendly Notion-style relative or absolute format.
 */
function getDateDisplayString(dateStr: string, timeStr: string | undefined, settings: NotionDatePluginSettings): string {
	const targetDate = parseLocalDate(dateStr);
	const relativeDay = settings.dateFormat === "relative"
		? getNotionStyleRelativeDate(targetDate, settings)
		: formatAbsoluteDate(targetDate, settings.dateFormat);

	if (timeStr) {
		return `@${relativeDay}, ${formatTimeValue(timeStr, settings)}`;
	}

	return `@${relativeDay}`;
}

function parseTimeToken(timeToken: string): string | null {
	const match = timeToken.trim().match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/i);
	if (!match) return null;

	let hours = parseInt(match[1], 10);
	const minutes = match[2] ?? "00";
	const meridiem = match[3]?.toLowerCase();

	if (meridiem) {
		if (hours < 1 || hours > 12) return null;
		if (meridiem === "pm" && hours !== 12) hours += 12;
		if (meridiem === "am" && hours === 12) hours = 0;
	} else if (hours > 23) {
		return null;
	}

	return `${String(hours).padStart(2, "0")}:${minutes}`;
}

function extractTime(input: string): { dateText: string; timeStr?: string } {
	const timeMatch = input.match(/\s+(?:at\s+)?((?:[01]?\d|2[0-3]):[0-5]\d\s*(?:am|pm)?|(?:1[0-2]|0?[1-9])\s*(?:am|pm))$/i);
	if (!timeMatch) {
		return { dateText: input };
	}

	const parsedTime = parseTimeToken(timeMatch[1]);
	if (!parsedTime) {
		return { dateText: input };
	}

	return {
		dateText: input.slice(0, timeMatch.index).trim(),
		timeStr: parsedTime
	};
}

function normalizeSmartDateInput(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/^@/, "")
		.replace(/\s+/g, " ")
		.replace(/,$/, "");
}

function parseSmartDate(input: string, baseDate = new Date()): ParsedSmartDate | null {
	const normalized = normalizeSmartDateInput(input);
	if (!normalized) return null;

	const { dateText, timeStr } = extractTime(normalized);
	const text = dateText.replace(/^(on|for)\s+/, "");
	const today = new Date(baseDate);
	today.setHours(0, 0, 0, 0);

	if (text === "now") {
		const hours = String(baseDate.getHours()).padStart(2, "0");
		const minutes = String(baseDate.getMinutes()).padStart(2, "0");
		return { date: today, timeStr: `${hours}:${minutes}` };
	}

	if (text === "today") return { date: today, timeStr };
	if (text === "tomorrow") return { date: addDays(today, 1), timeStr };
	if (text === "yesterday") return { date: addDays(today, -1), timeStr };
	if (text === "next week") return { date: addDays(today, 7), timeStr };
	if (text === "next month") return { date: addMonths(today, 1), timeStr };
	if (text === "next year") return { date: addYears(today, 1), timeStr };

	const inRelativeMatch = text.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)$/);
	if (inRelativeMatch) {
		const amount = parseInt(inRelativeMatch[1], 10);
		const unit = inRelativeMatch[2];
		if (unit.startsWith("day")) return { date: addDays(today, amount), timeStr };
		if (unit.startsWith("week")) return { date: addDays(today, amount * 7), timeStr };
		if (unit.startsWith("month")) return { date: addMonths(today, amount), timeStr };
		return { date: addYears(today, amount), timeStr };
	}

	const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (isoMatch) {
		const year = parseInt(isoMatch[1], 10);
		const month = parseInt(isoMatch[2], 10);
		const day = parseInt(isoMatch[3], 10);
		const date = new Date(year, month - 1, day);
		if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
			return { date, timeStr };
		}
	}

	const numericMatch = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
	if (numericMatch) {
		const month = parseInt(numericMatch[1], 10);
		const day = parseInt(numericMatch[2], 10);
		let year = numericMatch[3] ? parseInt(numericMatch[3], 10) : today.getFullYear();
		if (year < 100) year += 2000;

		let date = new Date(year, month - 1, day);
		if (!numericMatch[3] && daysBetween(date, today) < 0) {
			date = new Date(year + 1, month - 1, day);
		}

		if (date.getMonth() === month - 1 && date.getDate() === day) {
			return { date, timeStr };
		}
	}

	const monthFirstMatch = text.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/);
	if (monthFirstMatch && MONTHS[monthFirstMatch[1]] !== undefined) {
		const month = MONTHS[monthFirstMatch[1]];
		const day = parseInt(monthFirstMatch[2], 10);
		let year = monthFirstMatch[3] ? parseInt(monthFirstMatch[3], 10) : today.getFullYear();
		let date = new Date(year, month, day);
		if (!monthFirstMatch[3] && daysBetween(date, today) < 0) {
			year += 1;
			date = new Date(year, month, day);
		}

		if (date.getMonth() === month && date.getDate() === day) {
			return { date, timeStr };
		}
	}

	const dayFirstMatch = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:,?\s+(\d{4}))?$/);
	if (dayFirstMatch && MONTHS[dayFirstMatch[2]] !== undefined) {
		const day = parseInt(dayFirstMatch[1], 10);
		const month = MONTHS[dayFirstMatch[2]];
		let year = dayFirstMatch[3] ? parseInt(dayFirstMatch[3], 10) : today.getFullYear();
		let date = new Date(year, month, day);
		if (!dayFirstMatch[3] && daysBetween(date, today) < 0) {
			year += 1;
			date = new Date(year, month, day);
		}

		if (date.getMonth() === month && date.getDate() === day) {
			return { date, timeStr };
		}
	}

	const weekdayMatch = text.match(/^(?:(next|this|last)\s+)?([a-z]+)$/);
	if (weekdayMatch && WEEKDAY_INDEX[weekdayMatch[2]] !== undefined) {
		const modifier = weekdayMatch[1];
		const targetDay = WEEKDAY_INDEX[weekdayMatch[2]];
		let diff = (targetDay - today.getDay() + 7) % 7;

		if (modifier === "next") {
			diff = diff === 0 ? 7 : diff;
		} else if (modifier === "last") {
			diff = diff === 0 ? -7 : diff - 7;
		} else if (modifier === "this") {
			diff = targetDay - today.getDay();
		} else if (diff === 0) {
			diff = 0;
		}

		return { date: addDays(today, diff), timeStr };
	}

	return null;
}

function formatParsedValue(parsed: ParsedSmartDate): string {
	const dateValue = formatDateValue(parsed.date);
	return parsed.timeStr ? `${dateValue} ${parsed.timeStr}` : dateValue;
}

/**
 * Custom Date and Time Picker Modal using standard HTML5 inputs.
 */
export class CustomDatePickerModal extends Modal {
	onSubmit: (dateVal: string) => void;
	initialDate: string;
	initialTime: string;
	hasTime: boolean;

	constructor(app: App, onSubmit: (dateVal: string) => void, initialVal?: string) {
		super(app);
		this.onSubmit = onSubmit;

		this.initialDate = "";
		this.initialTime = "";
		this.hasTime = false;

		if (initialVal) {
			const match = initialVal.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
			if (match) {
				this.initialDate = match[1];
				if (match[2]) {
					this.initialTime = match[2];
					this.hasTime = true;
				}
			}
		}

		if (!this.initialDate) {
			const now = new Date();
			const year = now.getFullYear();
			const month = String(now.getMonth() + 1).padStart(2, "0");
			const day = String(now.getDate()).padStart(2, "0");
			this.initialDate = `${year}-${month}-${day}`;

			const hours = String(now.getHours()).padStart(2, "0");
			const minutes = String(now.getMinutes()).padStart(2, "0");
			this.initialTime = `${hours}:${minutes}`;
		}
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Choose Date and Time", cls: "notion-date-modal-title" });

		const flexContainer = contentEl.createEl("div", { cls: "notion-date-modal-container" });

		// Initialize Inputs immediately so they can be referenced by event listeners
		const dateInput = document.createElement("input");
		dateInput.type = "date";
		dateInput.value = this.initialDate;

		const timeInput = document.createElement("input");
		timeInput.type = "time";
		timeInput.value = this.initialTime;

		// Focus and click listeners to auto-trigger the picker dropdown
		const triggerPicker = (inputEl: HTMLInputElement) => {
			try {
				inputEl.showPicker();
			} catch (e) {}
		};

		dateInput.addEventListener("click", () => triggerPicker(dateInput));
		dateInput.addEventListener("focus", () => triggerPicker(dateInput));

		timeInput.addEventListener("click", () => triggerPicker(timeInput));
		timeInput.addEventListener("focus", () => triggerPicker(timeInput));

		// Date Input Row
		const dateRow = flexContainer.createEl("div", { cls: "notion-date-modal-row" });
		dateRow.createEl("label", { text: "Date:" });
		dateRow.appendChild(dateInput);

		// Include Time Toggle
		const timeToggleRow = flexContainer.createEl("div", { cls: "notion-date-modal-row checkbox-row" });
		const timeCheckboxLabel = timeToggleRow.createEl("label");
		const timeCheckbox = timeCheckboxLabel.createEl("input", { type: "checkbox" });
		timeCheckbox.checked = this.hasTime;
		timeCheckboxLabel.appendChild(document.createTextNode(" Include time"));

		// Time Input Container
		const timeRow = flexContainer.createEl("div", { cls: "notion-date-modal-row" });
		timeRow.createEl("label", { text: "Time:" });
		timeRow.appendChild(timeInput);

		// Toggle time input visibility
		const toggleTimeVisibility = () => {
			if (timeCheckbox.checked) {
				timeRow.style.display = "flex";
			} else {
				timeRow.style.display = "none";
			}
		};
		timeCheckbox.addEventListener("change", toggleTimeVisibility);
		toggleTimeVisibility();

		// Buttons
		const buttonRow = contentEl.createEl("div", { cls: "notion-date-modal-buttons" });

		const cancelButton = buttonRow.createEl("button", { text: "Cancel", cls: "mod-cancel" });
		cancelButton.addEventListener("click", () => this.close());

		const submitButton = buttonRow.createEl("button", { text: "Confirm", cls: "mod-cta" });
		submitButton.addEventListener("click", () => {
			const finalDate = dateInput.value;
			if (!finalDate) return;

			let result = finalDate;
			if (timeCheckbox.checked && timeInput.value) {
				result += " " + timeInput.value;
			}

			this.onSubmit(result);
			this.close();
		});

		// Auto-focus date input on modal open to trigger the picker immediately
		setTimeout(() => {
			dateInput.focus();
			triggerPicker(dateInput);
		}, 150);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Interface representing the suggestion list structure.
 */
interface NotionDateSuggestion {
	label: string;
	value: string;
	displayText: string;
	searchText?: string;
}

/**
 * Autocomplete editor suggestions popover when typing "@".
 */
class NotionDateSuggest extends EditorSuggest<NotionDateSuggestion> {
	constructor(private plugin: NotionDatePlugin) {
		super(plugin.app);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
		const line = editor.getLine(cursor.line);
		const sub = line.substring(0, cursor.ch);

		// Match "@" followed by a short natural-language date query.
		const match = sub.match(/(?:^|\s)@([A-Za-z0-9,./\-\s]*)$/);
		if (!match) return null;

		const triggerCharIndex = sub.length - match[1].length - 1;

		return {
			start: { line: cursor.line, ch: triggerCharIndex },
			end: cursor,
			query: match[1]
		};
	}

	getSuggestions(context: EditorSuggestContext): NotionDateSuggestion[] {
		const query = normalizeSmartDateInput(context.query);
		const now = new Date();

		const todayDate = new Date(now);
		const yesterdayDate = new Date(now);
		yesterdayDate.setDate(yesterdayDate.getDate() - 1);
		const tomorrowDate = new Date(now);
		tomorrowDate.setDate(tomorrowDate.getDate() + 1);

		const todayStr = formatDateValue(todayDate);
		const yesterdayStr = formatDateValue(yesterdayDate);
		const tomorrowStr = formatDateValue(tomorrowDate);

		const hours = String(now.getHours()).padStart(2, "0");
		const minutes = String(now.getMinutes()).padStart(2, "0");
		const nowStr = `${todayStr} ${hours}:${minutes}`;

		const options: NotionDateSuggestion[] = [
			{ label: "today", value: todayStr, displayText: "@Today", searchText: "today" },
			{ label: "yesterday", value: yesterdayStr, displayText: "@Yesterday", searchText: "yesterday" },
			{ label: "tomorrow", value: tomorrowStr, displayText: "@Tomorrow", searchText: "tomorrow" },
			{ label: "now", value: nowStr, displayText: "@Now (Date & Time)", searchText: "now" },
			{ label: "date", value: "custom", displayText: "@Choose date..." }
		];

		for (const weekday of WEEKDAYS) {
			const parsed = parseSmartDate(`next ${weekday}`, now);
			if (!parsed) continue;
			const value = formatParsedValue(parsed);
			options.push({
				label: `next ${weekday.toLowerCase()}`,
				value,
				displayText: getDateDisplayString(formatDateValue(parsed.date), parsed.timeStr, this.plugin.settings),
				searchText: `${weekday.toLowerCase()} next ${weekday.toLowerCase()}`
			});
		}

		if (query) {
			const parsed = parseSmartDate(query, now);
			if (parsed) {
				const value = formatParsedValue(parsed);
				return [{
					label: query,
					value,
					displayText: getDateDisplayString(formatDateValue(parsed.date), parsed.timeStr, this.plugin.settings),
					searchText: query
				}];
			}
		}

		return options.filter((opt) => (opt.searchText ?? opt.label).includes(query));
	}

	renderSuggestion(suggestion: NotionDateSuggestion, el: HTMLElement): void {
		const container = el.createEl("div", { cls: "notion-date-suggestion-item" });
		container.createEl("span", { text: suggestion.displayText, cls: "suggestion-display" });
		if (suggestion.value !== "custom") {
			container.createEl("span", { text: ` (${suggestion.value})`, cls: "suggestion-hint" });
		}
	}

	selectSuggestion(suggestion: NotionDateSuggestion, evt: MouseEvent | KeyboardEvent): void {
		if (!this.context) return;
		const editor = this.context.editor;
		const start = this.context.start;
		const end = this.context.end;

		// Clear the trigger text (@...)
		editor.replaceRange("", start, end);

		if (suggestion.value === "custom") {
			new CustomDatePickerModal(this.app, (dateVal) => {
				const insertedText = `@[${dateVal}]`;
				editor.replaceRange(insertedText, start);
				editor.setCursor({ line: start.line, ch: start.ch + insertedText.length });
			}).open();
		} else {
			const insertedText = `@[${suggestion.value}]`;
			editor.replaceRange(insertedText, start);
			editor.setCursor({ line: start.line, ch: start.ch + insertedText.length });
		}
	}
}

/**
 * CodeMirror 6 inline widget to render the Notion-style pill in Live Preview.
 */
class NotionDateWidget extends WidgetType {
	constructor(
		readonly dateStr: string,
		readonly timeStr: string | undefined,
		readonly rawText: string,
		readonly settings: NotionDatePluginSettings,
		readonly onClick: () => void
	) {
		super();
	}

	eq(other: NotionDateWidget): boolean {
		return (
			this.dateStr === other.dateStr &&
			this.timeStr === other.timeStr &&
			this.rawText === other.rawText &&
			this.settings.dateFormat === other.settings.dateFormat &&
			this.settings.timeFormat === other.settings.timeFormat &&
			this.settings.weekStartsOn === other.settings.weekStartsOn
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const span = document.createElement("span");
		span.className = "notion-date-pill";
		span.textContent = getDateDisplayString(this.dateStr, this.timeStr, this.settings);

		// Style based on relative time offset
		const targetDate = parseLocalDate(this.dateStr);
		const diffDays = daysBetween(targetDate, startOfToday());

		if (diffDays === 0) {
			span.classList.add("notion-date-today");
		} else if (diffDays < 0) {
			span.classList.add("notion-date-past");
		} else {
			span.classList.add("notion-date-future");
		}

		span.title = `Date: ${this.dateStr}${this.timeStr ? " " + this.timeStr : ""} (Click to edit)`;

		// Mousedown event handler to prevent CodeMirror cursor placement and layout shift
		span.addEventListener("mousedown", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.onClick();
		});

		// Click event handler to edit
		span.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.onClick();
		});

		return span;
	}

	ignoreEvent(event: Event): boolean {
		return event.type !== "mousedown" && event.type !== "click";
	}
}

/**
 * Scanning state logic and builder for CodeMirror 6 replace decorations.
 */
function buildDecorations(
	state: EditorState,
	settings: NotionDatePluginSettings,
	onWidgetClick: (from: number, to: number, rawText: string) => void
): DecorationSet {
	const widgets: Range<Decoration>[] = [];
	const text = state.doc.toString();
	const selection = state.selection;

	// Search for `@[YYYY-MM-DD]` or `@[YYYY-MM-DD HH:mm]`
	const regex = /@\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?\]/g;
	let match;

	while ((match = regex.exec(text)) !== null) {
		const start = match.index;
		const end = start + match[0].length;

		// Skip decorating if the cursor overlaps with this range (including boundaries)
		let isCursorOverlapping = false;
		for (const range of selection.ranges) {
			if (
				(range.from >= start && range.to <= end) ||
				(range.from === start || range.to === end) ||
				(range.from >= start && range.from <= end) ||
				(range.to >= start && range.to <= end)
			) {
				isCursorOverlapping = true;
				break;
			}
		}

		if (!isCursorOverlapping) {
			const dateStr = match[1];
			const timeStr = match[2];
			const rawText = match[0];

			const deco = Decoration.replace({
				widget: new NotionDateWidget(dateStr, timeStr, rawText, settings, () => {
					onWidgetClick(start, end, rawText);
				}),
				side: 1
			});
			widgets.push(deco.range(start, end));
		}
	}

	return Decoration.set(widgets, true);
}

/**
 * Creates the CodeMirror 6 Editor Extension StateField.
 */
function createNotionDateExtension(
	app: App,
	getSettings: () => NotionDatePluginSettings,
	onWidgetClick: (from: number, to: number, rawText: string) => void
) {
	return StateField.define<DecorationSet>({
		create(state: EditorState): DecorationSet {
			return buildDecorations(state, getSettings(), onWidgetClick);
		},
		update(decorations: DecorationSet, transaction: Transaction): DecorationSet {
			if (transaction.docChanged || transaction.selection) {
				return buildDecorations(transaction.state, getSettings(), onWidgetClick);
			}
			return decorations.map(transaction.changes);
		},
		provide(field: StateField<DecorationSet>) {
			return EditorView.decorations.from(field);
		}
	});
}

/**
 * Core Obsidian Plugin definition.
 */
export default class NotionDatePlugin extends Plugin {
	settings: NotionDatePluginSettings = { ...DEFAULT_SETTINGS };

	async onload() {
		console.log("Loading Obsidian Notion Dates plugin...");
		await this.loadSettings();
		this.addSettingTab(new NotionDateSettingTab(this.app, this));

		// 1. Register the editor suggestions popup
		this.registerEditorSuggest(new NotionDateSuggest(this));

		// 2. Register the CodeMirror 6 extension for Live Preview
		const onWidgetClick = (from: number, to: number, rawText: string) => {
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView) return;

			const innerVal = rawText.slice(2, -1); // Extract content inside `@[` and `]`

			new CustomDatePickerModal(this.app, (newVal) => {
				const editor = activeView.editor;
				const startPos = editor.offsetToPos(from);
				const endPos = editor.offsetToPos(to);
				editor.replaceRange(`@[${newVal}]`, startPos, endPos);
			}, innerVal).open();
		};

		this.registerEditorExtension([createNotionDateExtension(this.app, () => this.settings, onWidgetClick)]);

		// 3. Register the MarkdownPostProcessor for Reading View
		this.registerMarkdownPostProcessor((element, context) => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
			const nodesToReplace: { node: Text; parent: Node; newNodes: Node[] }[] = [];

			let textNode: Text | null;
			const regex = /@\[(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?\]/g;

			while ((textNode = walker.nextNode() as Text | null)) {
				const text = textNode.nodeValue;
				if (!text) continue;

				regex.lastIndex = 0;
				if (regex.test(text)) {
					regex.lastIndex = 0;
					let lastIdx = 0;
					let match;
					const newNodes: Node[] = [];

					while ((match = regex.exec(text)) !== null) {
						const matchStart = match.index;
						const matchEnd = matchStart + match[0].length;

						// Add preceding plain text
						if (matchStart > lastIdx) {
							newNodes.push(document.createTextNode(text.substring(lastIdx, matchStart)));
						}

						const dateStr = match[1];
						const timeStr = match[2];
						const rawText = match[0];

						// Create styled HTML span pill
						const span = document.createElement("span");
						span.className = "notion-date-pill notion-date-reading";
						span.textContent = getDateDisplayString(dateStr, timeStr, this.settings);

						const targetDate = parseLocalDate(dateStr);
						const diffDays = daysBetween(targetDate, startOfToday());

						if (diffDays === 0) {
							span.classList.add("notion-date-today");
						} else if (diffDays < 0) {
							span.classList.add("notion-date-past");
						} else {
							span.classList.add("notion-date-future");
						}

						span.title = `Date: ${dateStr}${timeStr ? " " + timeStr : ""} (Click to edit)`;

						// Click event handler in Reading View (rewrites vault file contents directly)
						span.addEventListener("click", (evt) => {
							evt.preventDefault();
							evt.stopPropagation();

							const innerVal = rawText.slice(2, -1);
							new CustomDatePickerModal(this.app, (newVal) => {
								const activeFile = this.app.workspace.getActiveFile();
								if (activeFile) {
									this.app.vault.read(activeFile).then((fileContent) => {
										// Replace target raw text tag in file contents
										const updatedContent = fileContent.replace(rawText, `@[${newVal}]`);
										this.app.vault.modify(activeFile, updatedContent);
									});
								}
							}, innerVal).open();
						});

						newNodes.push(span);
						lastIdx = matchEnd;
					}

					// Add trailing plain text
					if (lastIdx < text.length) {
						newNodes.push(document.createTextNode(text.substring(lastIdx)));
					}

					nodesToReplace.push({
						node: textNode,
						parent: textNode.parentNode!,
						newNodes
					});
				}
			}

			// Perform text-to-node swaps
			for (const replacement of nodesToReplace) {
				const { node, parent, newNodes } = replacement;
				if (parent) {
					for (const newNode of newNodes) {
						parent.insertBefore(newNode, node);
					}
					parent.removeChild(node);
				}
			}
		});
	}

	onunload() {
		console.log("Unloading Obsidian Notion Dates plugin...");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshDateWidgets();
	}

	refreshDateWidgets() {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				const cm = (leaf.view.editor as unknown as { cm?: EditorView }).cm;
				if (cm) {
					cm.dispatch({ selection: cm.state.selection });
				}
			}
		});
	}
}

class NotionDateSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: NotionDatePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Notion Dates" });

		new Setting(containerEl)
			.setName("Date label format")
			.setDesc("Controls how date pills are displayed in live preview and reading view.")
			.addDropdown((dropdown) => dropdown
				.addOption("relative", "Notion-style relative")
				.addOption("short", "Short date")
				.addOption("medium", "Month day, year")
				.addOption("long", "Weekday, month day, year")
				.addOption("numeric", "Numeric date")
				.addOption("iso", "ISO date")
				.setValue(this.plugin.settings.dateFormat)
				.onChange(async (value) => {
					this.plugin.settings.dateFormat = value as DateFormatKey;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Time format")
			.setDesc("Controls the time text shown when a date includes a time.")
			.addDropdown((dropdown) => dropdown
				.addOption("12-hour", "12-hour")
				.addOption("24-hour", "24-hour")
				.setValue(this.plugin.settings.timeFormat)
				.onChange(async (value) => {
					this.plugin.settings.timeFormat = value as TimeFormatKey;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Week starts on")
			.setDesc("Used by Notion-style relative labels such as Tuesday, Next Monday, and Last Friday.")
			.addDropdown((dropdown) => dropdown
				.addOption("sunday", "Sunday")
				.addOption("monday", "Monday")
				.setValue(this.plugin.settings.weekStartsOn)
				.onChange(async (value) => {
					this.plugin.settings.weekStartsOn = value as WeekStartsOnKey;
					await this.plugin.saveSettings();
				}));
	}
}
