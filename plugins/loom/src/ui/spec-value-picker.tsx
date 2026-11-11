// A 44 px way to comment on any value of a Spec section on a phone or a touch screen, where the values themselves stay
// text-sized so the spec reads as prose. It lists what the section can comment on, as the page renders it, so it can
// never offer a value the page does not show or miss one it does.
import { useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { BUTTON, FIELD } from "./common";
import { Sheet } from "./kit";
import { PHONE_TEXT } from "./narrow";

type Value = { path: string; label: string; text: string; group: string; noted: boolean; el: HTMLElement };

const GROUP = "[data-settings-card], [data-guardrail], [data-repo-files], [data-ticket-detail]";

/** The commentable values inside `scope`, in page order, each with the card it sits in. */
export function valuesIn(scope: HTMLElement, fallback: string): Value[] {
  return [...scope.querySelectorAll<HTMLElement>("[data-comment-target]")].map((el) => ({
    path: el.dataset.commentTarget!,
    label: (el.title || "").replace(/^Comment on /, "") || el.dataset.commentTarget!,
    // What the page shows: the rendered text, without the hover badge and pins, one line per option of a choice.
    text: (el.innerText || el.textContent || "").split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join(" · ").slice(0, 90),
    group: el.parentElement?.closest<HTMLElement>(GROUP)?.getAttribute("aria-label") ?? fallback,
    noted: el.hasAttribute("data-noted"),
    el,
  }));
}

/**
 * `bar`: a full-width 44 px row under the section's title, on a phone or a touch screen. `header`: a compact button in the
 * section's header everywhere else, so a value too small to tap or click has an equivalent control at every width.
 */
export function ValuePicker({ title, scope, placement }: { title: string; scope(): HTMLElement | null; placement: "bar" | "header" }) {
  const [values, setValues] = useState<Value[] | null>(null);
  const [query, setQuery] = useState("");
  const shown = values === null ? [] : values.filter((value) => `${value.label} ${value.text} ${value.group}`.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = [...new Set(shown.map((value) => value.group))];
  const pick = (value: Value) => {
    setValues(null);
    // After the sheet has closed and handed focus back: the value's own tap opens the comment box beside it.
    requestAnimationFrame(() => {
      if (!value.el.isConnected) return;
      value.el.scrollIntoView({ block: "center" });
      value.el.click();
    });
  };
  return (
    <>
      <button
        type="button"
        data-value-picker={title}
        data-placement={placement}
        aria-label={`Comment on a value in ${title}`}
        className={
          placement === "bar"
            ? "hidden min-h-11 w-full cursor-pointer flex-wrap items-center gap-x-2 rounded-md border border-border-seam bg-card px-3 py-1.5 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring @max-xl/loom:flex max-[576px]:flex pointer-coarse:flex"
            : `${BUTTON} @max-xl/loom:hidden max-[576px]:hidden pointer-coarse:hidden`
        }
        onClick={() => {
          const node = scope();
          setQuery("");
          setValues(node === null ? [] : valuesIn(node, title));
        }}
      >
        <Icon name="MessageSquare" aria-hidden className="size-4 shrink-0 text-[var(--loom-muted)]" />
        <span className="min-w-[min(100%,8rem)] flex-1">Comment on a value</span>
        {placement === "bar" && <span className="min-w-0 text-xs text-[var(--loom-muted)]">{title}</span>}
      </button>
      {/* Mounted only while open: every section draws two of these, and a closed dialog root still renders on each pass. */}
      {values !== null && (
      <Sheet open onOpenChange={(open) => !open && setValues(null)} label={`Comment on a value in ${title}`} className="max-h-[80vh]">
        <div className="flex items-center gap-2 border-b border-border-seam p-2">
          <input aria-label={`Find a value in ${title}`} placeholder={`Find a value in ${title}`} className={`${FIELD} min-h-11 flex-1 ${PHONE_TEXT}`} value={query} onChange={(event) => setQuery(event.target.value)} />
          <button type="button" className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md px-3 text-sm hover:bg-state-hover" onClick={() => setValues(null)}>
            Close
          </button>
        </div>
        <div data-value-list className="min-h-0 flex-1 overflow-y-auto p-1">
          {values !== null && shown.length === 0 && (
            <p role="status" className="p-3 text-sm text-[var(--loom-muted)]">
              {values.length === 0 ? `Nothing in ${title} takes a comment here.` : `No value matches “${query.trim()}”.`}
            </p>
          )}
          {groups.map((group) => (
            <section key={group} aria-label={group}>
              <h3 className="px-2.5 pt-2 pb-1 text-xs font-semibold text-[var(--loom-muted)]">{group}</h3>
              <ul>
                {shown
                  .filter((value) => value.group === group)
                  .map((value, index) => (
                    <li key={`${value.path} ${index}`}>
                      <button type="button" data-pick={value.path} className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => pick(value)}>
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate text-sm font-medium" title={value.label}>
                            {value.label}
                          </span>
                          {value.text !== "" && value.text !== value.label && (
                            <span className="truncate text-xs text-[var(--loom-muted)]" title={value.text}>
                              {value.text}
                            </span>
                          )}
                        </span>
                        {value.noted && <span className="shrink-0 rounded-full border border-warning-text px-1.5 text-[11px] leading-4 text-[var(--loom-warn)]">commented</span>}
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      </Sheet>
      )}
    </>
  );
}
