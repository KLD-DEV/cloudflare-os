import { describe, expect, it } from "vitest";
import {
  ActionDescriptionBuilder,
  buildDescription,
  codeSpan,
  defuseFences,
  plainInline,
  quoteUntrusted,
  sanitizeTitle,
  truncateToBytes,
} from "../src/action-description";

const encoder = new TextEncoder();

describe("ActionDescriptionBuilder", () => {
  it("renders content inside a fence the content cannot close", () => {
    const payload = "before\n```\nescaped\n```\nafter ````";
    const { description, descriptionIsComplete } =
      buildDescription("Posts a comment.").verbatim("Body", payload).finish();

    expect(descriptionIsComplete).toBe(true);
    // Five backticks: one more than the longest run in the payload.
    expect(description).toBe(`Posts a comment.\n\n**Body:**\n\n\`\`\`\`\`\n${payload}\n\`\`\`\`\``);
    // The bytes between the fences are exactly the payload.
    expect(description.split("`````")[1]).toBe(`\n${payload}\n`);
  });

  it("puts the info string on the opening fence", () => {
    const { description } = buildDescription().verbatim("SQL", "select 1", "sql").finish();
    expect(description).toBe("**SQL:**\n\n```sql\nselect 1\n```");
  });

  it("keeps a short value inline and moves an unrepresentable one into a block", () => {
    const { description, descriptionIsComplete } = buildDescription()
      .inline("Title", "Fix the build")
      .inline("Note", "has `ticks`")
      .inline("Multi", "two\nlines")
      .inline("Padded", " edge ")
      .inline("Long", "x".repeat(121))
      .finish();

    expect(descriptionIsComplete).toBe(true);
    expect(description).toContain("**Title:** `Fix the build`");
    expect(description).toContain("**Note:**\n\n```\nhas `ticks`\n```");
    expect(description).toContain("**Multi:**\n\n```\ntwo\nlines\n```");
    expect(description).toContain("**Padded:**\n\n```\n edge \n```");
    expect(description).toContain(`**Long:**\n\n\`\`\`\n${"x".repeat(121)}\n\`\`\``);
  });

  it("names empty content instead of rendering an empty block", () => {
    const { description, descriptionIsComplete } = buildDescription()
      .verbatim("Body", "")
      .inline("Title", "")
      .list("Labels", [])
      .finish();

    expect(descriptionIsComplete).toBe(true);
    expect(description).toBe("**Body:** _(empty)_\n\n**Title:** _(empty)_\n\n**Labels:** _(none)_");
  });

  it("renders a list one item per line, or as JSON when an item has a line break", () => {
    expect(buildDescription().list("Labels", ["bug", "help wanted"]).finish().description)
      .toBe("**Labels:**\n\n```\nbug\nhelp wanted\n```");
    expect(buildDescription().list("Labels", ["a\nb", "c"]).finish().description)
      .toBe('**Labels:**\n\n```json\n[\n  "a\\nb",\n  "c"\n]\n```');
  });

  it("pretty-prints JSON and marks an unserializable value incomplete", () => {
    const complete = buildDescription().json("Arguments", { a: 1, b: ["x"] }).finish();
    expect(complete).toEqual({
      description: '**Arguments:**\n\n```json\n{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n```',
      descriptionIsComplete: true,
    });

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const incomplete = buildDescription().json("Arguments", cyclic).finish();
    expect(incomplete.description).toBe("**Arguments:** _(could not be displayed)_");
    expect(Object.hasOwn(incomplete, "descriptionIsComplete")).toBe(false);

    // `undefined` has no JSON form at all.
    expect(buildDescription().json("Value", undefined).finish().description)
      .toBe("**Value:** _(could not be displayed)_");
  });

  it("truncates an oversize field on a UTF-8 boundary, notes it, and drops the flag", () => {
    const builder = new ActionDescriptionBuilder(undefined, { maxBytes: 400 });
    // Three-byte code points, so an arbitrary byte cut would land mid-character.
    const body = "€".repeat(1000);
    const { description, descriptionIsComplete } = builder.verbatim("Body", body).finish();

    expect(descriptionIsComplete).toBeUndefined();
    const shown = description.split("```")[1]!.slice(1, -1);
    expect(shown).toMatch(/^€+$/);
    expect(description).toContain(`_Truncated: showing ${shown.length * 3} of 3000 bytes._`);
    expect(encoder.encode(description).byteLength).toBeLessThanOrEqual(400);
  });

  it("omits later fields once the budget is spent", () => {
    const builder = new ActionDescriptionBuilder("Intro.", { maxBytes: 300 });
    const { description, descriptionIsComplete } = builder
      .verbatim("First", "a".repeat(1000))
      .verbatim("Second", "b")
      .inline("Third", "c")
      .finish();

    expect(descriptionIsComplete).toBeUndefined();
    expect(description).toContain("_Truncated: showing");
    expect(description).toContain("**Second:** _(omitted: description limit reached)_");
    // Inline values take the same path, so nothing slips past the cap on the label's line.
    expect(description).toContain("**Third:** _(omitted: description limit reached)_");
    // Only the placeholders sit past the budget.
    const [shown] = description.split("\n\n**Second:**");
    expect(encoder.encode(shown).byteLength).toBeLessThanOrEqual(300);
  });

  it("counts prose against the budget without cutting it", () => {
    const builder = new ActionDescriptionBuilder("p".repeat(500), { maxBytes: 300 });
    const { description, descriptionIsComplete } = builder.verbatim("Body", "b").finish();

    expect(description.startsWith("p".repeat(500))).toBe(true);
    expect(description).toContain("**Body:** _(omitted: description limit reached)_");
    expect(descriptionIsComplete).toBeUndefined();
  });

  it("puts the completeness key on the result only when set", () => {
    expect(Object.hasOwn(buildDescription("Prose only.").finish(), "descriptionIsComplete"))
      .toBe(true);
    const incomplete = new ActionDescriptionBuilder(undefined, { maxBytes: 10 })
      .verbatim("Body", "long enough to be cut").finish();
    expect(Object.hasOwn(incomplete, "descriptionIsComplete")).toBe(false);
  });
});

describe("truncateToBytes", () => {
  it("returns short text unchanged", () => {
    expect(truncateToBytes("héllo", 6)).toEqual({ text: "héllo", truncated: false });
  });

  it("never splits a code point", () => {
    // "é" is two bytes; a cut at byte 2 lands inside it.
    expect(truncateToBytes("aéb", 2)).toEqual({ text: "a", truncated: true });
    expect(truncateToBytes("aéb", 3)).toEqual({ text: "aé", truncated: true });
    // A four-byte emoji, cut at every offset inside it.
    for (const max of [1, 2, 3]) expect(truncateToBytes("😀x", max).text).toBe("");
    expect(truncateToBytes("😀x", 4).text).toBe("😀");
  });
});

describe("sanitizers", () => {
  it("defuses fences", () => {
    expect(defuseFences("a ``` b ```` c")).toBe("a ''' b ''' c");
  });

  it("block-quotes untrusted prose without headings or fences", () => {
    expect(quoteUntrusted("## Heading\n> quoted\n```\nx", 100)).toBe("> Heading\n> quoted\n> '''\n> x");
    expect(quoteUntrusted("abcdef", 3)).toBe("> abc…");
  });

  it("bounds code spans and inline prose", () => {
    expect(codeSpan("a `b`\n c")).toBe("`a b c`");
    expect(codeSpan("")).toBe("`(unnamed)`");
    expect(codeSpan("abcdef", 3)).toBe("`abc…`");
    expect(plainInline("*a* [b](c) #d")).toBe("a bc d");
    expect(plainInline("  ")).toBe("(unnamed)");
  });

  it("flattens and caps titles", () => {
    expect(sanitizeTitle("one\r\ntwo\nthree")).toBe("one two three");
    expect(sanitizeTitle("x".repeat(300))).toHaveLength(200);
    expect(sanitizeTitle("abcdef", 3)).toBe("abc");
  });
});
