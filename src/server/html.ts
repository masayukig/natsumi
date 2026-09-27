/**
 * Markup for the dashboard (ADR 0049), escaped by default. What the pages show comes from natsumi and from outside
 * (her thinking, tool results, Slack), so no value put into a template is ever read as markup: only the template's
 * own literal text is, and a template put into another. Nothing else can make an `Html`, and there is no way to mark
 * a string as safe — but for the one renderer below, which escapes on its own.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ESCAPES[character]!);
}

export class Html {
  // A private field, so that an object copied from the prototype or shaped like one is not taken for a template.
  readonly #text: string;
  private constructor(text: string) { this.#text = text; }
  get text(): string { return this.#text; }
  static from(strings: TemplateStringsArray, values: unknown[]): Html {
    let text = strings[0]!;
    values.forEach((value, index) => { text += render(value) + strings[index + 1]!; });
    return new Html(text);
  }
  static is(value: unknown): value is Html { return typeof value === 'object' && value !== null && #text in value; }
  static rendered(text: string): Html { return new Html(text); }
}

/**
 * Markup made by the Markdown renderer of her files (ADR 0054), and by nothing else: it is set to let no raw HTML
 * through and escapes every text and attribute itself, and the links and images it keeps are rewritten first.
 */
export function markdownMarkup(text: string): Html {
  return Html.rendered(text);
}

/** The tag for templates: html`<p>${text}</p>`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  return Html.from(strings, values);
}

/** A template as is; a list item by item; nothing for null, undefined and false; anything else as escaped text. */
function render(value: unknown): string {
  if (Html.is(value)) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}
