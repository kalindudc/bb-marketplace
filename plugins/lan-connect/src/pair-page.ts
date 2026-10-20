export const PAIR_PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  // Not no-referrer: under it Chrome submits this page's own form with `Origin: null`, which the pairing check refuses.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

const STYLE = `
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { width: min(22rem, calc(100vw - 2rem)); }
h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
p { line-height: 1.4; margin: 0 0 1rem; opacity: .85; }
label { display: block; font-size: .9rem; margin: 0 0 1rem; }
input { display: block; box-sizing: border-box; width: 100%; margin-top: .3rem; padding: .6rem .7rem; font: inherit; border-radius: .5rem; border: 1px solid GrayText; }
#code { font-family: ui-monospace, monospace; font-size: 1.3rem; letter-spacing: .15em; text-transform: uppercase; }
button { width: 100%; padding: .7rem; font: inherit; font-weight: 600; border: 0; border-radius: .5rem; background: #2563eb; color: white; }
.error { color: #dc2626; }
a { color: #2563eb; }
`;

export function pairPage(args: { code: string; name: string; error: string | null; paired: boolean }): string {
  const body = args.paired
    ? `<h1>This device is already paired</h1><p><a href="/">Open bb</a></p>`
    : `<h1>Pair with bb</h1>
<p>Enter the code from <code>bb lan pair</code> or Settings → LAN Connect on the computer that runs bb.</p>
${args.error === null ? "" : `<p class="error" role="alert">${escapeHtml(args.error)}</p>`}
<form method="post" action="/__bb-lan/pair">
<label>Pairing code<input id="code" name="code" value="${escapeHtml(args.code)}" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required maxlength="16"></label>
<label>Device name<input name="name" value="${escapeHtml(args.name)}" maxlength="64"></label>
<button type="submit">Pair this device</button>
</form>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pair with bb</title><style>${STYLE}</style></head>
<body><main>${body}</main></body>
</html>
`;
}
