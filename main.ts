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
	TFile,
	MarkdownSectionInformation,
	ToggleComponent,
	setIcon
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
	StateEffect,
	StateField,
	Transaction
} from '@codemirror/state';

// Global DATE_REGEX used throughout the plugin
const DATE_REGEX = /@\[([^\]]+)\]/g;
const refreshDateDecorationsEffect = StateEffect.define<void>();

type DateFormatKey = "relative" | "short" | "medium" | "long" | "iso" | "numeric";
type TimeFormatKey = "12-hour" | "24-hour";
type WeekStartsOnKey = "sunday" | "monday";
type MarkdownDateFormatKey = "iso" | "slash" | "us" | "long" | "custom";

interface NotionDatePluginSettings {
	dateFormat: DateFormatKey;
	timeFormat: TimeFormatKey;
	weekStartsOn: WeekStartsOnKey;
	markdownDateFormat: MarkdownDateFormatKey;
	customMarkdownDateFormat: string;
}

const DEFAULT_SETTINGS: NotionDatePluginSettings = {
	dateFormat: "relative",
	timeFormat: "12-hour",
	weekStartsOn: "sunday",
	markdownDateFormat: "iso",
	customMarkdownDateFormat: "YYYY-MM-DD"
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

const FULL_MONTH_NAMES = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december"
];

const MONTH_LABELS = FULL_MONTH_NAMES.map((month) => month[0].toUpperCase() + month.slice(1));

const WEEKDAY_INDEX: Record<string, number> = WEEKDAYS.reduce((acc, weekday, index) => {
	acc[weekday.toLowerCase()] = index;
	acc[weekday.slice(0, 3).toLowerCase()] = index;
	return acc;
}, {} as Record<string, number>);

interface ParsedSmartDate {
	date: Date;
	timeStr?: string;
}

interface ParsedDateTag {
	dateStr: string;
	timeStr?: string;
}

interface DateTokenPart {
	token?: "YYYY" | "YY" | "MM" | "M" | "DD" | "D";
	literal?: string;
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

function getLocalDateKey(): string {
	return formatDateValue(new Date());
}

function getDelayUntilNextLocalDay(): number {
	const now = new Date();
	const nextDay = new Date(now);
	nextDay.setDate(now.getDate() + 1);
	nextDay.setHours(0, 0, 1, 0);
	return Math.max(1000, nextDay.getTime() - now.getTime());
}

function getMarkdownDateFormatPattern(settings: NotionDatePluginSettings): string {
	if (settings.markdownDateFormat === "slash") return "YYYY/MM/DD";
	if (settings.markdownDateFormat === "us") return "MM/DD/YYYY";
	if (settings.markdownDateFormat === "long") return "MMMM D, YYYY";
	if (settings.markdownDateFormat === "custom") {
		const customPattern = settings.customMarkdownDateFormat || DEFAULT_SETTINGS.customMarkdownDateFormat;
		return isValidDatePattern(customPattern) ? customPattern : DEFAULT_SETTINGS.customMarkdownDateFormat;
	}
	return "YYYY-MM-DD";
}

function tokenizeDatePattern(pattern: string): DateTokenPart[] {
	const parts: DateTokenPart[] = [];
	const tokens: NonNullable<DateTokenPart["token"]>[] = ["YYYY", "YY", "MM", "M", "DD", "D"];
	let index = 0;

	while (index < pattern.length) {
		const token = tokens.find((candidate) => pattern.slice(index, index + candidate.length) === candidate);
		if (token) {
			parts.push({ token });
			index += token.length;
		} else {
			const literalStart = index;
			index += 1;
			while (index < pattern.length && !tokens.some((candidate) => pattern.slice(index, index + candidate.length) === candidate)) {
				index += 1;
			}
			parts.push({ literal: pattern.slice(literalStart, index) });
		}
	}

	return parts;
}

function formatDateWithPattern(date: Date, pattern: string): string {
	const values: Record<NonNullable<DateTokenPart["token"]>, string> = {
		YYYY: String(date.getFullYear()),
		YY: String(date.getFullYear()).slice(-2),
		MM: String(date.getMonth() + 1).padStart(2, "0"),
		M: String(date.getMonth() + 1),
		DD: String(date.getDate()).padStart(2, "0"),
		D: String(date.getDate())
	};

	return tokenizeDatePattern(pattern)
		.map((part) => part.token ? values[part.token] : part.literal)
		.join("");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDateWithPattern(value: string, pattern: string): Date | null {
	const parts = tokenizeDatePattern(pattern);
	const seenTokens = new Set<string>();
	let regexSource = "^";

	for (const part of parts) {
		if (part.literal !== undefined) {
			regexSource += escapeRegExp(part.literal);
			continue;
		}

		if (!part.token || seenTokens.has(part.token)) return null;
		seenTokens.add(part.token);

		if (part.token === "YYYY") regexSource += `(?<${part.token}>\\d{4})`;
		if (part.token === "YY") regexSource += `(?<${part.token}>\\d{2})`;
		if (part.token === "MM" || part.token === "DD") regexSource += `(?<${part.token}>\\d{2})`;
		if (part.token === "M" || part.token === "D") regexSource += `(?<${part.token}>\\d{1,2})`;
	}

	regexSource += "$";
	const match = value.match(new RegExp(regexSource));
	if (!match?.groups) return null;

	const yearValue = match.groups.YYYY ?? match.groups.YY;
	const monthValue = match.groups.MM ?? match.groups.M;
	const dayValue = match.groups.DD ?? match.groups.D;
	if (!yearValue || !monthValue || !dayValue) return null;

	const year = yearValue.length === 2 ? 2000 + parseInt(yearValue, 10) : parseInt(yearValue, 10);
	const month = parseInt(monthValue, 10);
	const day = parseInt(dayValue, 10);
	const date = new Date(year, month - 1, day);

	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
		return null;
	}

	return date;
}

function isValidDatePattern(pattern: string): boolean {
	const parts = tokenizeDatePattern(pattern);
	const tokens = parts.map((part) => part.token).filter(Boolean);
	const hasYear = tokens.includes("YYYY") || tokens.includes("YY");
	const hasMonth = tokens.includes("MM") || tokens.includes("M");
	const hasDay = tokens.includes("DD") || tokens.includes("D");
	const uniqueTokens = new Set(tokens);

	return hasYear && hasMonth && hasDay && uniqueTokens.size === tokens.length;
}

function formatMarkdownDateValue(date: Date, settings: NotionDatePluginSettings): string {
	if (settings.markdownDateFormat === "long") {
		return date.toLocaleDateString(undefined, {
			month: "long",
			day: "numeric",
			year: "numeric"
		});
	}

	return formatDateWithPattern(date, getMarkdownDateFormatPattern(settings));
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

	const slashIsoMatch = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
	if (slashIsoMatch) {
		const year = parseInt(slashIsoMatch[1], 10);
		const month = parseInt(slashIsoMatch[2], 10);
		const day = parseInt(slashIsoMatch[3], 10);
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

function formatMarkdownDateTagContent(parsed: ParsedSmartDate, settings: NotionDatePluginSettings): string {
	const dateValue = formatMarkdownDateValue(parsed.date, settings);
	return parsed.timeStr ? `${dateValue} ${parsed.timeStr}` : dateValue;
}

function formatMarkdownDateTagFromValue(value: string, settings: NotionDatePluginSettings): string {
	const parsed = parseSmartDate(value);
	if (!parsed) return value;
	return formatMarkdownDateTagContent(parsed, settings);
}

function parseDateTagContent(content: string, settings?: NotionDatePluginSettings): ParsedDateTag | null {
	if (settings?.markdownDateFormat === "custom") {
		const { dateText, timeStr } = extractTime(normalizeSmartDateInput(content));
		const date = parseDateWithPattern(dateText, getMarkdownDateFormatPattern(settings));
		if (date) {
			return {
				dateStr: formatDateValue(date),
				timeStr
			};
		}
	}

	const parsed = parseSmartDate(content);
	if (!parsed) return null;
	return {
		dateStr: formatDateValue(parsed.date),
		timeStr: parsed.timeStr
	};
}

function createDateSuggestion(label: string, parsed: ParsedSmartDate, settings: NotionDatePluginSettings, searchText?: string): NotionDateSuggestion {
	return {
		label,
		value: formatParsedValue(parsed),
		displayText: getDateDisplayString(formatDateValue(parsed.date), parsed.timeStr, settings),
		searchText: searchText ?? label
	};
}

function getPartialSmartDateSuggestions(query: string, baseDate: Date, settings: NotionDatePluginSettings): NotionDateSuggestion[] {
	const suggestions: NotionDateSuggestion[] = [];

	const weekdayMatch = query.match(/^(?:(next|this|last)\s+)?([a-z]{1,})$/);
	if (weekdayMatch) {
		const modifier = weekdayMatch[1];
		const weekdayPrefix = weekdayMatch[2];
		const weekdayMatches = WEEKDAYS.filter((weekday) => weekday.toLowerCase().startsWith(weekdayPrefix));
		for (const weekday of weekdayMatches) {
			const label = modifier ? `${modifier} ${weekday.toLowerCase()}` : weekday.toLowerCase();
			const parsed = parseSmartDate(label, baseDate);
			if (parsed) {
				suggestions.push(createDateSuggestion(label, parsed, settings, `${weekday.toLowerCase()} ${label}`));
			}
		}
	}

	const monthDayMatch = query.match(/^([a-z]{1,})(?:\s+(\d{1,2}))?$/);
	if (monthDayMatch) {
		const monthPrefix = monthDayMatch[1];
		const dayText = monthDayMatch[2];
		const monthNames = FULL_MONTH_NAMES.filter((monthName) => monthName.startsWith(monthPrefix));

		if (dayText) {
			const day = parseInt(dayText, 10);
			for (const monthName of monthNames) {
				if (day < 1 || day > 31) continue;
				const parsed = parseSmartDate(`${monthName} ${day}`, baseDate);
				if (parsed) {
					suggestions.push(createDateSuggestion(`${monthName} ${day}`, parsed, settings, `${monthName} ${day}`));
				}
			}
		} else {
			for (const monthName of monthNames) {
				const parsed = parseSmartDate(`${monthName} 1`, baseDate);
				if (parsed) {
					suggestions.push(createDateSuggestion(`${monthName} 1`, parsed, settings, `${monthName} ${monthPrefix}`));
				}
			}
		}
	}

	return suggestions;
}

function dedupeSuggestions(suggestions: NotionDateSuggestion[]): NotionDateSuggestion[] {
	const seen = new Set<string>();
	const deduped: NotionDateSuggestion[] = [];

	for (const suggestion of suggestions) {
		const key = `${suggestion.value}|${suggestion.displayText}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(suggestion);
	}

	return deduped;
}

function getLineStartOffset(content: string, line: number): number {
	if (line <= 0) return 0;

	let offset = 0;
	let currentLine = 0;
	while (currentLine < line) {
		const nextLineBreak = content.indexOf("\n", offset);
		if (nextLineBreak === -1) return content.length;
		offset = nextLineBreak + 1;
		currentLine += 1;
	}

	return offset;
}

function replaceNthOccurrence(text: string, search: string, replacement: string, occurrenceIndex: number): string | null {
	let fromIndex = 0;
	let seen = 0;

	while (fromIndex <= text.length) {
		const index = text.indexOf(search, fromIndex);
		if (index === -1) return null;

		if (seen === occurrenceIndex) {
			return text.slice(0, index) + replacement + text.slice(index + search.length);
		}

		seen += 1;
		fromIndex = index + search.length;
	}

	return null;
}

function replaceDateTagInContent(
	content: string,
	rawText: string,
	replacement: string,
	sectionInfo: MarkdownSectionInformation | null,
	occurrenceIndex: number
): string {
	if (sectionInfo) {
		const sectionStart = getLineStartOffset(content, sectionInfo.lineStart);
		const sectionEnd = sectionInfo.lineEnd + 1 > sectionInfo.lineStart
			? getLineStartOffset(content, sectionInfo.lineEnd + 1)
			: content.length;
		const sectionText = content.slice(sectionStart, sectionEnd);
		const updatedSection = replaceNthOccurrence(sectionText, rawText, replacement, occurrenceIndex);

		if (updatedSection !== null) {
			return content.slice(0, sectionStart) + updatedSection + content.slice(sectionEnd);
		}
	}

	return replaceNthOccurrence(content, rawText, replacement, 0) ?? content;
}

/** A theme-aware calendar with local dates and optional, inline time entry. */
export class CustomDatePickerModal extends Modal {
	private static nextId = 0;
	private readonly id = `notion-date-picker-${++CustomDatePickerModal.nextId}`;
	private selectedDate: Date;
	private focusedDate: Date;
	private visibleMonth: Date;
	private hasTime: boolean;
	private initialTime: string;
	private dateInput!: HTMLInputElement;
	private hourInput!: HTMLInputElement;
	private minuteInput!: HTMLInputElement;
	private meridiemInput!: HTMLSelectElement;
	private timeToggle!: ToggleComponent;
	private timeControls!: HTMLElement;
	private monthLabel!: HTMLElement;
	private calendarBody!: HTMLTableSectionElement;
	private errorEl!: HTMLElement;
	private saveButton!: HTMLButtonElement;

	constructor(
		app: App,
		private readonly onSubmit: (dateVal: string) => void,
		private readonly initialVal?: string,
		private readonly settings: NotionDatePluginSettings = DEFAULT_SETTINGS
	) {
		super(app);
		const parsed = initialVal ? parseDateTagContent(initialVal) : null;
		this.selectedDate = parsed ? parseLocalDate(parsed.dateStr) : startOfToday();
		this.focusedDate = new Date(this.selectedDate);
		this.visibleMonth = new Date(this.selectedDate.getFullYear(), this.selectedDate.getMonth(), 1);
		this.hasTime = !!parsed?.timeStr;
		const now = new Date();
		this.initialTime = parsed?.timeStr ?? `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("notion-date-picker");
		this.setTitle(this.initialVal ? "Edit date" : "Choose date");
		const form = contentEl.createEl("form", { cls: "notion-date-picker-form" });
		form.noValidate = true;
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.submit();
		});

		const inputWrap = form.createDiv({ cls: "notion-date-input-wrap" });
		setIcon(inputWrap.createSpan({ cls: "notion-date-input-icon" }), "calendar");
		this.dateInput = inputWrap.createEl("input", { type: "text", cls: "notion-date-input" });
		this.dateInput.setAttribute("aria-label", "Date");
		this.dateInput.setAttribute("aria-describedby", `${this.id}-hint ${this.id}-error`);
		this.dateInput.autocomplete = "off";
		this.dateInput.spellcheck = false;
		this.dateInput.value = this.dateLabel(this.selectedDate);
		this.dateInput.addEventListener("focus", () => this.dateInput.select());
		this.dateInput.addEventListener("input", () => this.readDateInput());
		this.dateInput.addEventListener("change", () => {
			if (parseSmartDate(this.dateInput.value)) this.dateInput.value = this.dateLabel(this.selectedDate);
			this.updateValidity();
		});
		form.createDiv({
			cls: "notion-date-input-hint",
			text: "Try “tomorrow” or “May 29”",
			attr: { id: `${this.id}-hint` }
		});

		const shortcuts = form.createDiv({ cls: "notion-date-shortcuts" });
		for (const [label, offset] of [["Today", 0], ["Tomorrow", 1], ["In a week", 7]] as const) {
			const button = shortcuts.createEl("button", { text: label, attr: { type: "button" } });
			button.addEventListener("click", () => this.selectDate(addDays(startOfToday(), offset)));
		}

		const calendar = form.createDiv({ cls: "notion-date-calendar" });
		const header = calendar.createDiv({ cls: "notion-date-calendar-header" });
		this.monthLabel = header.createDiv({ attr: { id: `${this.id}-month`, "aria-live": "polite" } });
		const navigation = header.createDiv({ cls: "notion-date-calendar-navigation" });
		for (const [label, icon, offset] of [["Previous month", "chevron-left", -1], ["Next month", "chevron-right", 1]] as const) {
			const button = navigation.createEl("button", { attr: { type: "button", "aria-label": label } });
			setIcon(button, icon);
			button.addEventListener("click", () => {
				this.focusedDate = this.shiftMonth(this.focusedDate, offset);
				this.visibleMonth = new Date(this.focusedDate.getFullYear(), this.focusedDate.getMonth(), 1);
				this.renderCalendar();
			});
		}
		const table = calendar.createEl("table", { attr: { role: "grid", "aria-labelledby": `${this.id}-month`, "aria-describedby": `${this.id}-keys` } });
		const headings = table.createEl("thead").createEl("tr");
		const firstDay = this.settings.weekStartsOn === "monday" ? 1 : 0;
		for (let column = 0; column < 7; column++) {
			const weekday = WEEKDAYS[(firstDay + column) % 7];
			headings.createEl("th", { text: weekday.slice(0, 2), attr: { scope: "col", abbr: weekday } });
		}
		this.calendarBody = table.createEl("tbody");
		calendar.createDiv({
			cls: "notion-date-visually-hidden",
			text: "Use arrow keys to move between days, Home and End to move within a week, and Page Up or Page Down to change months. Press Enter or Space to select a date.",
			attr: { id: `${this.id}-keys` }
		});

		const timeSection = form.createDiv({ cls: "notion-date-time-section" });
		const timeHeading = timeSection.createDiv({ cls: "notion-date-time-heading" });
		timeHeading.createSpan({ text: "Include time" });
		this.timeToggle = new ToggleComponent(timeHeading).setValue(this.hasTime).onChange((enabled) => {
			this.setTimeEnabled(enabled);
			if (enabled) {
				this.hourInput.focus();
				this.hourInput.select();
			}
		});
		this.timeToggle.toggleEl.setAttribute("aria-label", "Include time");
		this.timeToggle.toggleEl.setAttribute("aria-controls", `${this.id}-time`);
		this.timeControls = timeSection.createDiv({ cls: "notion-date-time-controls", attr: { id: `${this.id}-time` } });
		const timeGroup = this.timeControls.createDiv({ cls: "notion-date-time-group", attr: { role: "group", "aria-label": "Time" } });
		const segments = timeGroup.createDiv({ cls: "notion-date-time-segments" });
		this.hourInput = this.createTimeInput(segments, "Hour", this.settings.timeFormat === "12-hour" ? 1 : 0, this.settings.timeFormat === "12-hour" ? 12 : 23);
		segments.createSpan({ text: ":", attr: { "aria-hidden": "true" } });
		this.minuteInput = this.createTimeInput(segments, "Minute", 0, 59);
		this.meridiemInput = timeGroup.createEl("select", { attr: { "aria-label": "AM or PM" } });
		for (const value of ["AM", "PM"]) this.meridiemInput.createEl("option", { text: value, value });
		this.meridiemInput.hidden = this.settings.timeFormat === "24-hour";
		this.meridiemInput.addEventListener("change", () => this.updateValidity());
		const nowButton = this.timeControls.createEl("button", { text: "Now", attr: { type: "button" }, cls: "notion-date-time-now" });
		nowButton.addEventListener("click", () => {
			const now = new Date();
			this.setTime(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
			this.updateValidity();
		});
		this.setTime(this.initialTime);
		this.setTimeEnabled(this.hasTime);

		this.errorEl = form.createDiv({ cls: "notion-date-picker-error", attr: { id: `${this.id}-error`, "aria-live": "polite" } });
		this.errorEl.hidden = true;
		const buttons = form.createDiv({ cls: "notion-date-picker-buttons" });
		buttons.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => this.close());
		this.saveButton = buttons.createEl("button", { text: "Save", attr: { type: "submit" }, cls: "mod-cta" });
		this.renderCalendar();
		this.updateValidity();
		this.focusedDayButton()?.focus();
	}

	private dateLabel(date: Date): string {
		// Use the parser's unambiguous month-name format, independently of the OS locale.
		return `${MONTH_LABELS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
	}

	private selectDate(date: Date) {
		this.selectedDate = new Date(date);
		this.focusedDate = new Date(date);
		this.visibleMonth = new Date(date.getFullYear(), date.getMonth(), 1);
		this.dateInput.value = this.dateLabel(date);
		this.renderCalendar();
		this.updateValidity();
	}

	private readDateInput(): boolean {
		const parsed = parseSmartDate(this.dateInput.value);
		if (parsed) {
			this.selectedDate = parsed.date;
			this.focusedDate = new Date(parsed.date);
			this.visibleMonth = new Date(parsed.date.getFullYear(), parsed.date.getMonth(), 1);
			if (parsed.timeStr) {
				this.setTime(parsed.timeStr);
				this.setTimeEnabled(true);
			}
			this.renderCalendar();
		}
		this.updateValidity();
		return !!parsed;
	}

	private shiftMonth(date: Date, amount: number): Date {
		const month = new Date(date.getFullYear(), date.getMonth() + amount, 1);
		const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
		month.setDate(Math.min(date.getDate(), lastDay));
		return month;
	}

	private renderCalendar(focus = false) {
		this.monthLabel.setText(`${MONTH_LABELS[this.visibleMonth.getMonth()]} ${this.visibleMonth.getFullYear()}`);
		this.calendarBody.empty();
		const start = getWeekStart(this.visibleMonth, this.settings.weekStartsOn);
		const selectedKey = formatDateValue(this.selectedDate);
		const focusedKey = formatDateValue(this.focusedDate);
		const todayKey = getLocalDateKey();
		for (let week = 0; week < 6; week++) {
			const row = this.calendarBody.createEl("tr");
			for (let column = 0; column < 7; column++) {
				const date = addDays(start, week * 7 + column);
				const key = formatDateValue(date);
				const cell = row.createEl("td", { attr: { "aria-selected": String(key === selectedKey) } });
				const button = cell.createEl("button", {
					text: String(date.getDate()), cls: "notion-date-calendar-day",
					attr: { type: "button", "data-date": key, "aria-label": `${WEEKDAYS[date.getDay()]}, ${this.dateLabel(date)}`, tabindex: key === focusedKey ? "0" : "-1" }
				});
				button.toggleClass("is-outside-month", date.getMonth() !== this.visibleMonth.getMonth());
				button.toggleClass("is-selected", key === selectedKey);
				if (key === todayKey) button.setAttribute("aria-current", "date");
				button.addEventListener("focus", () => {
					this.focusedDate = new Date(date);
					for (const day of Array.from(this.calendarBody.querySelectorAll<HTMLButtonElement>("button"))) day.tabIndex = day === button ? 0 : -1;
				});
				button.addEventListener("click", () => {
					this.selectDate(date);
					this.focusedDayButton()?.focus();
				});
				button.addEventListener("keydown", (event) => this.onCalendarKey(event, date));
			}
		}
		if (focus) this.focusedDayButton()?.focus();
	}

	private focusedDayButton(): HTMLButtonElement | null {
		return this.calendarBody.querySelector(`button[data-date="${formatDateValue(this.focusedDate)}"]`);
	}

	private onCalendarKey(event: KeyboardEvent, date: Date) {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		let next: Date;
		switch (event.key) {
			case "ArrowLeft": next = addDays(date, -1); break;
			case "ArrowRight": next = addDays(date, 1); break;
			case "ArrowUp": next = addDays(date, -7); break;
			case "ArrowDown": next = addDays(date, 7); break;
			case "Home": next = getWeekStart(date, this.settings.weekStartsOn); break;
			case "End": next = addDays(getWeekStart(date, this.settings.weekStartsOn), 6); break;
			case "PageUp": next = this.shiftMonth(date, event.shiftKey ? -12 : -1); break;
			case "PageDown": next = this.shiftMonth(date, event.shiftKey ? 12 : 1); break;
			default: return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.focusedDate = next;
		this.visibleMonth = new Date(next.getFullYear(), next.getMonth(), 1);
		this.renderCalendar(true);
	}

	private createTimeInput(parent: HTMLElement, label: string, min: number, max: number): HTMLInputElement {
		const input = parent.createEl("input", { type: "text", attr: { "aria-label": label, "aria-describedby": `${this.id}-error` } });
		input.inputMode = "numeric";
		input.maxLength = 2;
		input.autocomplete = "off";
		input.addEventListener("focus", () => input.select());
		input.addEventListener("input", () => this.updateValidity());
		input.addEventListener("change", () => {
			if (/^\d{1,2}$/.test(input.value) && Number(input.value) >= min && Number(input.value) <= max) {
				input.value = input.value.padStart(2, "0");
			}
			this.updateValidity();
		});
		input.addEventListener("keydown", (event) => {
			if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
			event.preventDefault();
			const current = /^\d{1,2}$/.test(input.value) ? Number(input.value) : min;
			const next = current + (event.key === "ArrowUp" ? 1 : -1);
			input.value = String(next > max ? min : next < min ? max : next).padStart(2, "0");
			this.updateValidity();
		});
		return input;
	}

	private setTime(value: string) {
		const [hours, minutes] = value.split(":").map(Number);
		this.hourInput.value = String(this.settings.timeFormat === "12-hour" ? hours % 12 || 12 : hours).padStart(2, "0");
		this.minuteInput.value = String(minutes).padStart(2, "0");
		this.meridiemInput.value = hours >= 12 ? "PM" : "AM";
	}

	private setTimeEnabled(enabled: boolean) {
		this.hasTime = enabled;
		this.timeToggle.setValue(enabled);
		this.timeControls.hidden = !enabled;
		this.hourInput.disabled = !enabled;
		this.minuteInput.disabled = !enabled;
		this.meridiemInput.disabled = !enabled;
		if (this.saveButton) this.updateValidity();
	}

	private getTime(): string | null {
		if (!/^\d{1,2}$/.test(this.hourInput.value) || !/^\d{1,2}$/.test(this.minuteInput.value)) return null;
		return parseTimeToken(`${this.hourInput.value}:${this.minuteInput.value.padStart(2, "0")}${this.settings.timeFormat === "12-hour" ? this.meridiemInput.value : ""}`);
	}

	private updateValidity() {
		if (!this.saveButton) return;
		const dateValid = !!parseSmartDate(this.dateInput.value);
		const timeValid = !this.hasTime || this.getTime() !== null;
		this.dateInput.setAttribute("aria-invalid", String(!dateValid));
		this.hourInput.setAttribute("aria-invalid", String(!timeValid));
		this.minuteInput.setAttribute("aria-invalid", String(!timeValid));
		this.saveButton.disabled = !dateValid || !timeValid;
		if (!dateValid) this.showError("Enter a valid date, like “tomorrow”.");
		else if (!timeValid) this.showError(this.settings.timeFormat === "12-hour"
			? "Use hours 1–12 and minutes 00–59."
			: "Use hours 00–23 and minutes 00–59.");
		else {
			this.errorEl.setText("");
			this.errorEl.hidden = true;
		}
	}

	private showError(message: string) {
		this.errorEl.setText(message);
		this.errorEl.hidden = false;
	}

	private submit() {
		if (!this.readDateInput()) {
			this.showError("Enter a valid date before saving.");
			this.dateInput.focus();
			return;
		}
		const time = this.hasTime ? this.getTime() : null;
		if (this.hasTime && !time) {
			this.showError("Enter a valid time before saving.");
			this.hourInput.focus();
			return;
		}
		this.onSubmit(`${formatDateValue(this.selectedDate)}${time ? ` ${time}` : ""}`);
		this.close();
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
	private repositionQueued = false;
	private pendingSuggestionEl: HTMLElement | null = null;

	constructor(private plugin: NotionDatePlugin) {
		super(plugin.app);
		this.scope.register([], "Enter", (evt) => this.selectDefaultSuggestion(evt));
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

		const pinnedCustomOption: NotionDateSuggestion = { label: "date", value: "custom", displayText: "@Choose date..." };
		const options: NotionDateSuggestion[] = [
			{ label: "today", value: todayStr, displayText: "@Today", searchText: "today" },
			{ label: "yesterday", value: yesterdayStr, displayText: "@Yesterday", searchText: "yesterday" },
			{ label: "tomorrow", value: tomorrowStr, displayText: "@Tomorrow", searchText: "tomorrow" },
			{ label: "now", value: nowStr, displayText: "@Now (Date & Time)", searchText: "now" }
		];

		for (const weekday of WEEKDAYS) {
			const parsed = parseSmartDate(`next ${weekday}`, now);
			if (!parsed) continue;
			const label = `next ${weekday.toLowerCase()}`;
			options.push(createDateSuggestion(label, parsed, this.plugin.settings, `${weekday.toLowerCase()} ${label}`));
		}

		const matchingSuggestions = options.filter((opt) => (opt.searchText ?? opt.label).includes(query));
		const smartSuggestions: NotionDateSuggestion[] = [];

		if (query) {
			const parsed = parseSmartDate(query, now);
			if (parsed) {
				smartSuggestions.push(createDateSuggestion(query, parsed, this.plugin.settings));
			}

			smartSuggestions.push(...getPartialSmartDateSuggestions(query, now, this.plugin.settings));
		}

		const dateSuggestions = dedupeSuggestions([
			...smartSuggestions,
			...matchingSuggestions
		]);

		if (query && dateSuggestions.length > 0) {
			return [
				...dateSuggestions,
				pinnedCustomOption
			];
		}

		return [
			pinnedCustomOption,
			...dateSuggestions
		];
	}

	renderSuggestion(suggestion: NotionDateSuggestion, el: HTMLElement): void {
		this.prepareSuggestionContainer(el);
		this.scheduleRepositionAbove();
		const container = el.createEl("div", {
			cls: `notion-date-suggestion-item${suggestion.value === "custom" ? " notion-date-suggestion-custom" : ""}`
		});
		container.createEl("span", { text: suggestion.displayText, cls: "suggestion-display" });
		if (suggestion.value !== "custom") {
			container.createEl("span", { text: ` (${suggestion.value})`, cls: "suggestion-hint" });
		}
	}

	private prepareSuggestionContainer(el: HTMLElement): void {
		const suggestionEl = el.closest(".suggestion-container") as HTMLElement | null;
		if (!suggestionEl) return;

		this.pendingSuggestionEl = suggestionEl;
		suggestionEl.classList.add("notion-date-suggestion-container", "notion-date-suggestion-positioning");
	}

	private pinCustomSuggestionToTop(suggestionEl: HTMLElement): void {
		const customItem = Array.from(suggestionEl.querySelectorAll<HTMLElement>(".suggestion-item"))
			.find((item) => item.querySelector(".notion-date-suggestion-custom"));
		const parent = customItem?.parentElement;
		if (!customItem || !parent || parent.firstElementChild === customItem) return;

		parent.insertBefore(customItem, parent.firstElementChild);
	}

	private scheduleRepositionAbove(): void {
		if (this.repositionQueued) return;
		this.repositionQueued = true;

		requestAnimationFrame(() => {
			this.repositionQueued = false;
			this.repositionAboveIfSpace();
		});
	}

	private repositionAboveIfSpace(): void {
		const suggestionEl = this.pendingSuggestionEl ?? this.getSuggestionContainer();
		if (!suggestionEl) return;

		try {
			if (!this.context) return;

			const editorView = (this.context.editor as unknown as { cm?: EditorView }).cm;
			if (!editorView) return;

			const offset = this.context.editor.posToOffset(this.context.start);
			const cursorRect = editorView.coordsAtPos(offset);
			if (!cursorRect) return;

			const margin = 8;
			const suggestionRect = suggestionEl.getBoundingClientRect();
			const top = cursorRect.top - suggestionRect.height - margin;
			if (top < margin) return;

			suggestionEl.style.top = `${top}px`;
			suggestionEl.style.bottom = "auto";
		} finally {
			this.pinCustomSuggestionToTop(suggestionEl);
			suggestionEl.classList.remove("notion-date-suggestion-positioning");
			this.updateDefaultSelection(suggestionEl);
			this.pendingSuggestionEl = null;
		}
	}

	private getSuggestionContainer(): HTMLElement | null {
		return Array.from(document.querySelectorAll<HTMLElement>(".suggestion-container"))
			.find((el) => el.querySelector(".notion-date-suggestion-item")) ?? null;
	}

	private getDefaultSuggestion(): NotionDateSuggestion | null {
		if (!this.context) return null;

		const query = normalizeSmartDateInput(this.context.query);
		if (!query) return null;

		return this.getSuggestions(this.context).find((suggestion) => suggestion.value !== "custom") ?? null;
	}

	private selectDefaultSuggestion(evt: KeyboardEvent): false | void {
		const suggestion = this.getDefaultSuggestion();
		if (!suggestion) return;

		evt.preventDefault();
		evt.stopPropagation();
		this.selectSuggestion(suggestion, evt);
		return false;
	}

	private updateDefaultSelection(suggestionEl: HTMLElement): void {
		if (!this.getDefaultSuggestion()) return;

		const items = Array.from(suggestionEl.querySelectorAll<HTMLElement>(".suggestion-item"));
		const defaultItem = items.find((item) => item.querySelector(".notion-date-suggestion-item:not(.notion-date-suggestion-custom)"));
		if (!defaultItem) return;

		for (const item of items) {
			item.classList.remove("is-selected");
		}
		defaultItem.classList.add("is-selected");
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
				const insertedText = `@[${formatMarkdownDateTagFromValue(dateVal, this.plugin.settings)}]`;
				editor.replaceRange(insertedText, start);
				editor.setCursor({ line: start.line, ch: start.ch + insertedText.length });
			}, undefined, this.plugin.settings).open();
		} else {
			const insertedText = `@[${formatMarkdownDateTagFromValue(suggestion.value, this.plugin.settings)}]`;
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

	// Search for parseable date tags such as `@[YYYY-MM-DD]`, `@[May 29, 2026]`, or `@[05/29/2026 14:30]`.
	const regex = new RegExp(DATE_REGEX);
	let match;

	while ((match = regex.exec(text)) !== null) {
		const parsedTag = parseDateTagContent(match[1], settings);
		if (!parsedTag) continue;

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
			const dateStr = parsedTag.dateStr;
			const timeStr = parsedTag.timeStr;
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
			const shouldRefresh = transaction.effects.some((effect) => effect.is(refreshDateDecorationsEffect));
			if (transaction.docChanged || transaction.selection || shouldRefresh) {
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
	private currentDateKey = getLocalDateKey();
	private nextDayTimeout: number | null = null;

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
			const parsedInnerVal = parseDateTagContent(innerVal, this.settings);
			const modalInitialVal = parsedInnerVal
				? `${parsedInnerVal.dateStr}${parsedInnerVal.timeStr ? " " + parsedInnerVal.timeStr : ""}`
				: innerVal;

			new CustomDatePickerModal(this.app, (newVal) => {
				const editor = activeView.editor;
				const startPos = editor.offsetToPos(from);
				const endPos = editor.offsetToPos(to);
				editor.replaceRange(`@[${formatMarkdownDateTagFromValue(newVal, this.settings)}]`, startPos, endPos);
			}, modalInitialVal, this.settings).open();
		};

		this.registerEditorExtension([createNotionDateExtension(this.app, () => this.settings, onWidgetClick)]);

		// 3. Register the MarkdownPostProcessor for Reading View
		this.registerMarkdownPostProcessor((element, context) => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
			const nodesToReplace: { node: Text; parent: Node; newNodes: Node[] }[] = [];
			const occurrenceCounts = new Map<string, number>();

			let textNode: Text | null;
			const regex = new RegExp(DATE_REGEX);

			while ((textNode = walker.nextNode() as Text | null)) {
				const text = textNode.nodeValue;
				if (!text) continue;

				regex.lastIndex = 0;
				if (regex.test(text)) {
					regex.lastIndex = 0;
					let lastIdx = 0;
					let match;
					const newNodes: Node[] = [];
					const sectionInfo = textNode.parentElement instanceof HTMLElement
						? context.getSectionInfo(textNode.parentElement)
						: null;

					while ((match = regex.exec(text)) !== null) {
						const parsedTag = parseDateTagContent(match[1], this.settings);
						if (!parsedTag) continue;

						const matchStart = match.index;
						const matchEnd = matchStart + match[0].length;

						// Add preceding plain text
						if (matchStart > lastIdx) {
							newNodes.push(document.createTextNode(text.substring(lastIdx, matchStart)));
						}

						const dateStr = parsedTag.dateStr;
						const timeStr = parsedTag.timeStr;
						const rawText = match[0];
						const occurrenceKey = `${sectionInfo?.lineStart ?? -1}:${sectionInfo?.lineEnd ?? -1}:${rawText}`;
						const occurrenceIndex = occurrenceCounts.get(occurrenceKey) ?? 0;
						occurrenceCounts.set(occurrenceKey, occurrenceIndex + 1);

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
							const parsedInnerVal = parseDateTagContent(innerVal, this.settings);
							const modalInitialVal = parsedInnerVal
								? `${parsedInnerVal.dateStr}${parsedInnerVal.timeStr ? " " + parsedInnerVal.timeStr : ""}`
								: innerVal;
							new CustomDatePickerModal(this.app, (newVal) => {
								const replacement = `@[${formatMarkdownDateTagFromValue(newVal, this.settings)}]`;
								this.replaceDateInReadingView(context.sourcePath, rawText, replacement, sectionInfo, occurrenceIndex);
							}, modalInitialVal, this.settings).open();
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

		this.registerDateRolloverRefresh();
	}

	onunload() {
		console.log("Unloading Obsidian Notion Dates plugin...");
	}

	private replaceDateInReadingView(
		sourcePath: string,
		rawText: string,
		replacement: string,
		sectionInfo: MarkdownSectionInformation | null,
		occurrenceIndex: number
	) {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) return;

		this.app.vault.process(file, (content) => {
			return replaceDateTagInContent(content, rawText, replacement, sectionInfo, occurrenceIndex);
		}).catch((error) => console.error("Failed to update Notion date tag:", error));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshDateWidgets();
	}

	private registerDateRolloverRefresh() {
		this.scheduleNextDayRefresh();
		this.registerDomEvent(window, "focus", () => this.refreshIfLocalDateChanged());
		this.registerDomEvent(document, "visibilitychange", () => {
			if (!document.hidden) {
				this.refreshIfLocalDateChanged();
			}
		});
		this.register(() => {
			if (this.nextDayTimeout !== null) {
				window.clearTimeout(this.nextDayTimeout);
				this.nextDayTimeout = null;
			}
		});
	}

	private scheduleNextDayRefresh() {
		if (this.nextDayTimeout !== null) {
			window.clearTimeout(this.nextDayTimeout);
		}

		this.nextDayTimeout = window.setTimeout(() => {
			this.refreshIfLocalDateChanged(true);
			this.scheduleNextDayRefresh();
		}, getDelayUntilNextLocalDay());
	}

	private refreshIfLocalDateChanged(force = false) {
		const nextDateKey = getLocalDateKey();
		if (!force && nextDateKey === this.currentDateKey) return;

		this.currentDateKey = nextDateKey;
		this.refreshDateWidgets();
	}

	refreshDateWidgets() {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				const cm = (leaf.view.editor as unknown as { cm?: EditorView }).cm;
				if (cm) {
					cm.dispatch({ effects: refreshDateDecorationsEffect.of() });
				}

				const previewMode = (leaf.view as unknown as { previewMode?: { rerender: (force?: boolean) => void } }).previewMode;
				previewMode?.rerender(true);
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
			.setName("Markdown date format")
			.setDesc("Controls the date format written inside date tags. ISO is the most portable default.")
			.addDropdown((dropdown) => dropdown
				.addOption("iso", "YYYY-MM-DD")
				.addOption("slash", "YYYY/MM/DD")
				.addOption("us", "MM/DD/YYYY")
				.addOption("long", "Month D, YYYY")
				.addOption("custom", "Custom")
				.setValue(this.plugin.settings.markdownDateFormat)
				.onChange(async (value) => {
					this.plugin.settings.markdownDateFormat = value as MarkdownDateFormatKey;
					await this.plugin.saveSettings();
					this.display();
				}));

		new Setting(containerEl)
			.setName("Custom markdown format")
			.setDesc("Use YYYY, YY, MM, M, DD, and D tokens. Example: YYYY-DD-MM.")
			.addText((text) => text
				.setPlaceholder("YYYY-MM-DD")
				.setValue(this.plugin.settings.customMarkdownDateFormat)
				.setDisabled(this.plugin.settings.markdownDateFormat !== "custom")
				.onChange(async (value) => {
					this.plugin.settings.customMarkdownDateFormat = value.trim() || DEFAULT_SETTINGS.customMarkdownDateFormat;
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
