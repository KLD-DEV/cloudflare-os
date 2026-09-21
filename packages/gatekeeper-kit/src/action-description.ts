/**
 * Approver-facing action descriptions that reproduce their content verbatim.
 *
 * An approver deciding whether an action may leave the workspace can only vouch for text they can
 * read. `ActionDescriptionBuilder` renders each content-bearing field of an action into a fenced
 * block whose bytes are exactly the field's value, tracks one byte budget across every field, and
 * sets `descriptionIsComplete` on the result only when nothing was dropped. The sanitizers below
 * are for untrusted text that has to sit in the description's own prose, such as a provider-chosen
 * name inside a sentence; they trade fidelity for safety and are never used for content the
 * approver is asked to review.
 */

import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";

/**
 * Longest description the builder renders, in UTF-8 bytes. The overseer stores each action record
 * (title, description, caller, timestamps, kind) as one Durable Object value, and such values are
 * limited to 128 KiB after serialization. Staying below 96 KiB leaves room for the record's other
 * fields and for the storage wrapper.
 */
export const MAX_ACTION_DESCRIPTION_BYTES = 96 * 1024;

/** Longest untrusted value shown inline in prose, in characters. */
export const MAX_INLINE_TEXT = 120;

/** Longest action title, in characters. */
export const MAX_TITLE_LENGTH = 200;

/** The description fields of an `ActionDescription`, ready to spread into one. */
export type RenderedDescription =
  Pick<ActionDescription, "description"> & { descriptionIsComplete?: true };

// Bytes reserved beside each field for its truncation note, so the note itself fits the budget.
const TRUNCATION_NOTE_RESERVE = 80;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Cuts `text` to at most `maxBytes` of UTF-8, on a code point boundary.
 * @returns The (possibly shortened) text and whether anything was removed.
 */
export function truncateToBytes(text: string, maxBytes: number):
    { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let cut = Math.max(0, maxBytes);
  // A continuation byte is 10xxxxxx; step back to the start of the code point it belongs to.
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return { text: decoder.decode(bytes.subarray(0, cut)), truncated: true };
}

// The shortest backtick fence that `text` cannot close: one longer than its longest run, and at
// least the three CommonMark requires. The bytes inside then need no escaping at all.
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

// A value a code span reproduces exactly: no backtick, no line break, no edge whitespace CommonMark
// would strip, and short enough to read on one line.
function fitsInline(value: string): boolean {
  return value.length <= MAX_INLINE_TEXT && !/[`\r\n]/.test(value) && value.trim() === value;
}

/**
 * Accumulates the Markdown an approver reads before deciding, one field at a time, under a single
 * byte budget. Labels are the gatekeeper's own words; values are whatever the action will send.
 *
 * Content fields (`verbatim`, `json`, `list`, and `inline` when the value needs a block) render
 * inside a fenced code block, so the approver sees exact bytes and nothing in them renders as
 * Markdown, images or links included. A field that does not fit is truncated with a note, or
 * omitted once the budget is spent, and either case leaves `descriptionIsComplete` unset on the
 * result of `finish()`.
 */
export class ActionDescriptionBuilder {
  readonly #maxBytes: number;
  readonly #parts: string[] = [];
  #bytes = 0;
  #complete = true;

  /**
   * @param intro Optional opening prose, added as by `prose()`.
   * @param options.maxBytes Byte budget for the whole description; defaults to
   *   `MAX_ACTION_DESCRIPTION_BYTES`.
   */
  constructor(intro?: string, options: { maxBytes?: number } = {}) {
    this.#maxBytes = options.maxBytes ?? MAX_ACTION_DESCRIPTION_BYTES;
    if (intro !== undefined) this.prose(intro);
  }

  #push(part: string): void {
    // Parts are joined with a blank line; count the separator with the part it precedes.
    this.#bytes += byteLength(part) + (this.#parts.length ? 2 : 0);
    this.#parts.push(part);
  }

  // A whole field, or its placeholder when even that no longer fits. Placeholders are not
  // themselves budgeted: a description can end a few short lines over `maxBytes`, which the gap
  // between the default budget and the storage limit absorbs.
  #field(label: string, part: string): void {
    if (this.#bytes + byteLength(part) + 2 > this.#maxBytes) {
      this.#push(`**${label}:** _(omitted: description limit reached)_`);
      this.#complete = false;
      return;
    }
    this.#push(part);
  }

  /**
   * Adds the gatekeeper's own Markdown: a summary sentence, a warning, a provenance line. Counted
   * against the budget but never cut, since it is trusted text the gatekeeper keeps short.
   */
  prose(markdown: string): this {
    this.#push(markdown);
    return this;
  }

  /**
   * Adds a short value on the label's line, as a code span. A value a code span cannot reproduce
   * exactly (backticks, line breaks, edge whitespace, or too long for one line) is rendered as a
   * fenced block instead, so the field stays complete either way.
   */
  inline(label: string, value: string): this {
    if (value === "") {
      this.#field(label, `**${label}:** _(empty)_`);
    } else if (fitsInline(value)) {
      this.#field(label, `**${label}:** \`${value}\``);
    } else {
      this.verbatim(label, value);
    }
    return this;
  }

  /**
   * Adds a field whose value the approver must read in full, as a fenced block containing exactly
   * `text`. The fence is chosen so the text cannot close it.
   * @param lang Optional info string for syntax highlighting, such as `"json"` or `"sql"`.
   */
  verbatim(label: string, text: string, lang = ""): this {
    if (text === "") {
      this.#field(label, `**${label}:** _(empty)_`);
      return this;
    }
    const heading = `**${label}:**\n\n`;
    const fence = fenceFor(text);
    const framing = byteLength(heading) + byteLength(fence) * 2 + byteLength(lang) + 2 + 2;
    const room = this.#maxBytes - this.#bytes - framing - TRUNCATION_NOTE_RESERVE;
    if (room <= 0) {
      this.#push(`**${label}:** _(omitted: description limit reached)_`);
      this.#complete = false;
      return this;
    }
    const total = byteLength(text);
    const { text: shown, truncated } = truncateToBytes(text, room);
    let block = `${heading}${fence}${lang}\n${shown}\n${fence}`;
    if (truncated) {
      block += `\n\n_Truncated: showing ${byteLength(shown)} of ${total} bytes._`;
      this.#complete = false;
    }
    this.#push(block);
    return this;
  }

  /**
   * Adds a value as pretty-printed JSON in a fenced block. A value JSON cannot represent (a cycle,
   * a bigint, `undefined`) is reported as undisplayable and leaves the description incomplete.
   */
  json(label: string, value: unknown): this {
    let text: string | undefined;
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      this.#field(label, `**${label}:** _(could not be displayed)_`);
      this.#complete = false;
      return this;
    }
    return this.verbatim(label, text, "json");
  }

  /**
   * Adds a list of short values, one per line in a fenced block. An item containing a line break
   * would read as two, so such a list is rendered as JSON instead.
   */
  list(label: string, items: readonly string[]): this {
    if (items.length === 0) {
      this.#field(label, `**${label}:** _(none)_`);
      return this;
    }
    if (items.some(item => /[\r\n]/.test(item))) return this.json(label, items);
    return this.verbatim(label, items.join("\n"));
  }

  /**
   * Renders the description. `descriptionIsComplete` is present, and `true`, only when every
   * field was shown in full; the key is absent otherwise, so spreading the result into an
   * `ActionDescription` puts nothing on the wire for an incomplete one.
   */
  finish(): RenderedDescription {
    const description = this.#parts.join("\n\n");
    return this.#complete ? { description, descriptionIsComplete: true } : { description };
  }
}

/** Starts a description, optionally with opening prose. */
export function buildDescription(intro?: string): ActionDescriptionBuilder {
  return new ActionDescriptionBuilder(intro);
}

/**
 * Neutralizes Markdown fences in untrusted text about to be placed inside one, or quoted in prose.
 * Without it a value can close the fence and continue in the description's own voice. Content the
 * approver reviews goes through `ActionDescriptionBuilder.verbatim` instead, which needs no
 * escaping.
 */
export function defuseFences(text: string): string {
  return text.replace(/`{3,}/g, "'''");
}

/**
 * Renders untrusted prose safely inside a description, block-quoted. Left alone, a provider's own
 * text can write its own field lines and argue its case in the description's voice, so fences and
 * headings are neutralized and the text is capped.
 */
export function quoteUntrusted(text: string, max: number): string {
  const cleaned = defuseFences(text)
    // Repeated, since one strip leaves `##` as `#` -- still a heading, at heading weight, in the
    // description the approver reads.
    .replace(/^[ \t]*[#>]+[ \t]*/gm, "")
    .trim();
  const clipped = cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
  return clipped.split("\n").map(line => `> ${line}`).join("\n");
}

/**
 * Renders untrusted text inside a bounded Markdown code span.
 *
 * Backticks are dropped and whitespace is flattened so the value cannot escape into prose. Lossy:
 * use `ActionDescriptionBuilder.inline` for a value the approver must see exactly.
 */
export function codeSpan(text: string, max = MAX_INLINE_TEXT): string {
  const cleaned = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const clipped = cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
  return `\`${clipped || "(unnamed)"}\``;
}

/**
 * Renders untrusted text as inline prose, removing characters that could forge Markdown structure.
 * Lossy, like `codeSpan`.
 */
export function plainInline(text: string, max = MAX_INLINE_TEXT): string {
  const cleaned = text.replace(/[`*_[\]()#>|]/g, "").replace(/\s+/g, " ").trim();
  const clipped = cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
  return clipped || "(unnamed)";
}

/** Flattens untrusted text onto one line and caps it, for an action's title. */
export function sanitizeTitle(text: string, max = MAX_TITLE_LENGTH): string {
  return text.replace(/[\r\n]+/g, " ").slice(0, max);
}
