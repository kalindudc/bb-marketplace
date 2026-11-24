# Requests for bb

Upstream bb core capabilities and fixes that Tavern tracks, paired with Tavern's current mitigations. Recording an item here tracks engineering context and does not authorize a core change.

## 1. Preserve own JSON data properties during RPC normalization
- **Ask:** Construct normalized RPC JSON objects with own data properties (`Object.fromEntries`, `Object.defineProperty`, or null-prototype objects) so keys such as `__proto__` never invoke prototype setters.
- **Mitigation:** Tavern validates and strips unsafe keys at its own RPC and placement input boundaries.

## 2. Distinguish human-driven clients from agents
- **Ask:** Expose a trusted caller identity on RPC and CLI contexts separating a human desktop or terminal action from an agent invocation, carrying a non-forgeable thread ID whenever a request originates inside a bb thread.
- **Mitigation:** Tavern refuses plugin callers and any context carrying agent, thread, or CLI markers, blocks user-only Tavern commands in scoped shells, and records `client (unattested)` on receipts (such as Resume, Ask answers, Return, and Setup Apply) instead of claiming cryptographic proof of a human click.

## 3. Require an extension to load before a provider can run tools
- **Ask:** Provide a vetoable startup contract requiring a specified extension and scope revision to load before a provider executes its first tool, returning session-bound proof or a startup refusal.
- **Mitigation:** Tavern uses a marked Pi guard shim plus an armed-marker handshake checked by the watcher, and labels non-Pi and placed remote sessions as detection-only.

## 4. Offer a core exclusive-machine lease
- **Ask:** Provide a trusted exclusive machine lease with owner and lifetime so bb prevents another thread or plugin from reusing a checkout reserved for one member.
- **Mitigation:** Tavern tracks private placement generations, endpoints, and content-transfer holds in its own database and checks `HEAD` and checkout cleanliness before every carry and verdict.

## 5. Report actual context-card visibility and pane identity
- **Ask:** Report whether a thread's context card is actually visible alongside a stable pane identity.
- **Mitigation:** Tavern derives panel and widget layout defensively from available context props without assuming hidden cards are rendered.

## 6. Make plugin settings descriptions meet normal-text contrast
- **Ask:** Ensure bb's shared plugin-settings section descriptions meet WCAG AA 4.5:1 contrast across themes.
- **Mitigation:** Tavern renders its own section intro text inside `src/ui/page/settings.tsx` with compliant foreground tokens.

## 7. Keep page breadcrumbs clear of phone header actions
- **Ask:** Truncate earlier breadcrumb segments with an ellipsis on narrow screens so the final step stays visible without colliding with header actions.
- **Mitigation:** Tavern keeps page titles concise and tests narrow 390 px layouts.

## 8. Guarantee that hidden threads do not notify
- **Ask:** Exclude hidden threads from user-facing notifications regardless of default notification level.
- **Mitigation:** Tavern uses hidden threads only for non-notifying tale rendering and never sends user notifications for them.

## 9. Deduplicate thread sends with a caller-supplied request ID
- **Ask:** Support an idempotency key on `threads.send` so retrying after a reload or lost response never starts a duplicate turn.
- **Mitigation:** Tavern persists durable outbox batches and brief versions and reconciles uncertain acknowledgements before retrying.

## 10. Let plugin RPC reads re-render only for the fields a component uses
- **Ask:** Make `experimental_useRpcQuery` track accessed fields (or support `notifyOnChangeProps`) so background refetches do not trigger unnecessary re-renders.
- **Mitigation:** Tavern avoids layout reads during unrelated re-renders and minimizes polling and invalidation churn.

## 11. Give plugin Markdown explicit file routing
- **Ask:** Let bb's host Markdown component accept a thread or host identity for local file links independently of a document root.
- **Mitigation:** Tavern renders returned tales through a hidden companion renderer on the thread's context and falls back to cards linking back to the Keeper thread.

## 12. Let a composer banner draw over the transcript
- **Ask:** Offer a thread-scoped layer above the transcript and below the scroll-to-latest control, letting a plugin reserve bottom clearance while empty overlay space passes pointer and scroll input through to chat.
- **Mitigation:** Tavern keeps the character in a compact, transparent banner and leaves bb's composer fade alone. In bb 0.50.1 the sticky footer still paints over chat, and the banner slot has no transcript layer or scroll clearance.

## 13. Place a thread strip above the composer widget stack
- **Ask:** Provide an opt-in, thread-scoped slot directly below the conversation and above the entire composer widget stack, including banners from other plugins, with decorative areas passing pointer and scroll input through to chat.
- **Mitigation:** Tavern keeps the character and its own widget in one bare composer banner, with the character immediately above the Keeper or member row. Other plugins' banners can still appear first because bb orders banners by plugin ID and offers no priority setting.
