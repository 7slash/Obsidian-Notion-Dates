import {
	Plugin,
	Editor,
	MarkdownView,
	Modal,
	App,
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

/**
 * Formats YYYY-MM-DD and optional HH:mm into a friendly Notion-style relative or absolute format.
 */
function getRelativeDateString(dateStr: string, timeStr?: string): string {
	const targetDate = new Date(dateStr + "T00:00:00");
	const today = new Date();
	today.setHours(0, 0, 0, 0);

	const targetTime = targetDate.getTime();
	const todayTime = today.getTime();

	const diffDays = Math.round((targetTime - todayTime) / (1000 * 60 * 60 * 24));

	let relativeDay = "";
	if (diffDays === 0) {
		relativeDay = "Today";
	} else if (diffDays === -1) {
		relativeDay = "Yesterday";
	} else if (diffDays === 1) {
		relativeDay = "Tomorrow";
	} else {
		// Absolute date formatting e.g., "May 26, 2026"
		relativeDay = targetDate.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric"
		});
	}

	if (timeStr) {
		const [hoursStr, minutesStr] = timeStr.split(":");
		const hours = parseInt(hoursStr, 10);
		const ampm = hours >= 12 ? "pm" : "am";
		const hours12 = hours % 12 || 12;
		return `@${relativeDay}, ${hours12}:${minutesStr}${ampm}`;
	}

	return `@${relativeDay}`;
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
}

/**
 * Autocomplete editor suggestions popover when typing "@".
 */
class NotionDateSuggest extends EditorSuggest<NotionDateSuggestion> {
	constructor(app: App) {
		super(app);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
		const line = editor.getLine(cursor.line);
		const sub = line.substring(0, cursor.ch);

		// Match "@" optionally followed by characters, ensuring there is a space before "@" or it starts the line
		const match = sub.match(/(?:^|\s)@(\w*)$/);
		if (!match) return null;

		const triggerCharIndex = sub.length - match[1].length - 1;

		return {
			start: { line: cursor.line, ch: triggerCharIndex },
			end: cursor,
			query: match[1]
		};
	}

	getSuggestions(context: EditorSuggestContext): NotionDateSuggestion[] {
		const query = context.query.toLowerCase();
		const now = new Date();

		const getFormattedDate = (d: Date) => {
			const year = d.getFullYear();
			const month = String(d.getMonth() + 1).padStart(2, "0");
			const day = String(d.getDate()).padStart(2, "0");
			return `${year}-${month}-${day}`;
		};

		const todayDate = new Date(now);
		const yesterdayDate = new Date(now);
		yesterdayDate.setDate(yesterdayDate.getDate() - 1);
		const tomorrowDate = new Date(now);
		tomorrowDate.setDate(tomorrowDate.getDate() + 1);

		const todayStr = getFormattedDate(todayDate);
		const yesterdayStr = getFormattedDate(yesterdayDate);
		const tomorrowStr = getFormattedDate(tomorrowDate);

		const hours = String(now.getHours()).padStart(2, "0");
		const minutes = String(now.getMinutes()).padStart(2, "0");
		const nowStr = `${todayStr} ${hours}:${minutes}`;

		const options: NotionDateSuggestion[] = [
			{ label: "today", value: todayStr, displayText: "@Today" },
			{ label: "yesterday", value: yesterdayStr, displayText: "@Yesterday" },
			{ label: "tomorrow", value: tomorrowStr, displayText: "@Tomorrow" },
			{ label: "now", value: nowStr, displayText: "@Now (Date & Time)" },
			{ label: "date", value: "custom", displayText: "@Choose date..." }
		];

		return options.filter(opt => opt.label.contains(query));
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
		readonly onClick: () => void
	) {
		super();
	}

	eq(other: NotionDateWidget): boolean {
		return (
			this.dateStr === other.dateStr &&
			this.timeStr === other.timeStr &&
			this.rawText === other.rawText
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const span = document.createElement("span");
		span.className = "notion-date-pill";
		span.textContent = getRelativeDateString(this.dateStr, this.timeStr);

		// Style based on relative time offset
		const targetDate = new Date(this.dateStr + "T00:00:00");
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const diffDays = Math.round((targetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

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
				widget: new NotionDateWidget(dateStr, timeStr, rawText, () => {
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
	onWidgetClick: (from: number, to: number, rawText: string) => void
) {
	return StateField.define<DecorationSet>({
		create(state: EditorState): DecorationSet {
			return buildDecorations(state, onWidgetClick);
		},
		update(decorations: DecorationSet, transaction: Transaction): DecorationSet {
			if (transaction.docChanged || transaction.selection) {
				return buildDecorations(transaction.state, onWidgetClick);
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
	async onload() {
		console.log("Loading Obsidian Notion Dates plugin...");

		// 1. Register the editor suggestions popup
		this.registerEditorSuggest(new NotionDateSuggest(this.app));

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

		this.registerEditorExtension([createNotionDateExtension(this.app, onWidgetClick)]);

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
						span.textContent = getRelativeDateString(dateStr, timeStr);

						const targetDate = new Date(dateStr + "T00:00:00");
						const today = new Date();
						today.setHours(0, 0, 0, 0);
						const diffDays = Math.round((targetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

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
}
