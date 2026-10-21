// The rules bb's marketplace schema (v2) and stricter marketplaces that copy these plugins apply to an entry and its
// overview, so a listing that passes here passes there too.
export const OVERVIEW_MAX_CHARACTERS = 4000;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 32;
const MAX_SCREENSHOTS = 6;

const ENTRY_FIELDS = new Set(["id", "displayName", "description", "icon", "tags", "author", "source", "category", "screenshots", "overview"]);
const AUTHOR_FIELDS = new Set(["name", "github", "url"]);
const ID = /^[a-z0-9][a-z0-9-]*$/;
const ICON_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const ICON_URL = /^(?!http:)(?:https:\/\/)?[^\s]+\.(?:svg|png|webp)$/;
const TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_USER = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
const SCREENSHOT = /^(?:https:\/\/[^\s]+\.(?:png|jpg|jpeg|webp)|\.\/screenshots\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpg|jpeg|webp))$/;

const blank = (value) => typeof value !== "string" || value.trim() === "";

// Counted as the file is: a marketplace that inlines it untrimmed counts the final newline too.
export function overviewProblems(text) {
  const problems = [];
  if (text.length > OVERVIEW_MAX_CHARACTERS) {
    const newline = text.endsWith("\n") ? ", final newline included" : "";
    problems.push(`the overview has ${text.length} characters${newline}; the limit is ${OVERVIEW_MAX_CHARACTERS}`);
  }
  if (/^#\s/.test(text)) problems.push("the overview opens with a \"# \" title");
  if (/<[a-zA-Z][^>]*>/.test(text.replace(/`[^`]*`/g, ""))) problems.push("the overview contains raw HTML");
  if (/!\[/.test(text)) problems.push("the overview contains an image; use screenshots");
  if (/\]\((?!https:\/\/)/.test(text)) problems.push("the overview has a link that is not absolute https");
  return problems;
}

export function entryProblems(entry) {
  const problems = [];
  for (const key of Object.keys(entry)) if (!ENTRY_FIELDS.has(key)) problems.push(`unknown field "${key}"`);
  if (typeof entry.id !== "string" || !ID.test(entry.id)) problems.push(`the id "${entry.id}" must be lowercase letters, digits and dashes`);
  if (blank(entry.displayName)) problems.push("displayName must not be empty");
  if (blank(entry.description)) problems.push("description must not be empty");

  const { icon } = entry;
  if (typeof icon === "string") {
    if (!ICON_NAME.test(icon)) problems.push(`the icon "${icon}" is not an icon name`);
  } else if (typeof icon?.url !== "string" || !ICON_URL.test(icon.url)) {
    problems.push("the icon must be an icon name or { url } of an svg, png or webp file");
  }

  const tags = entry.tags ?? [];
  if (tags.length > MAX_TAGS) problems.push(`${tags.length} tags; the limit is ${MAX_TAGS}`);
  for (const tag of tags) {
    if (tag.length > MAX_TAG_LENGTH) problems.push(`the tag "${tag}" is longer than ${MAX_TAG_LENGTH} characters`);
    else if (!TAG.test(tag)) problems.push(`the tag "${tag}" must be lowercase letters and digits joined by dashes`);
  }

  const author = entry.author ?? {};
  for (const key of Object.keys(author)) if (!AUTHOR_FIELDS.has(key)) problems.push(`unknown author field "${key}"`);
  if (blank(author.name)) problems.push("author.name must not be empty");
  if (author.github !== undefined && !GITHUB_USER.test(author.github)) problems.push(`author.github "${author.github}" is not a GitHub user name`);
  if (author.url !== undefined && !String(author.url).startsWith("https://")) problems.push("author.url must start with https://");

  if (blank(entry.category)) problems.push("category is required");

  const screenshots = entry.screenshots ?? [];
  if (screenshots.length > MAX_SCREENSHOTS) problems.push(`${screenshots.length} screenshots; the limit is ${MAX_SCREENSHOTS}`);
  for (const shot of screenshots) {
    if (!SCREENSHOT.test(shot)) problems.push(`the screenshot "${shot}" must be an https URL or ./screenshots/<id>/<file>, as png, jpg or webp`);
  }

  if (blank(entry.overview)) problems.push("overview is required");
  return problems;
}
