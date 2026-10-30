import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

// One colour per person, the same everywhere, from the theme's terminal palette: every bb theme defines
// --ansi-N with a readable --ansi-bg-fg-N to write on it. The greys (0, 7, 8 and 15) are left out.
const SLOTS = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14];

function slotOf(login: string): number {
  let hash = 7;
  for (const char of login.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SLOTS[hash % SLOTS.length]!;
}

/** A person's initial in their colour; a team is square, a bot is a robot. */
export function Avatar({ login, team = false, bot = false, size = 22 }: { login: string; team?: boolean; bot?: boolean; size?: number }) {
  const box = { width: size, height: size };
  if (bot) {
    return (
      <span aria-hidden style={box} className="inline-flex shrink-0 items-center justify-center rounded-md bg-surface-recessed text-muted-foreground">
        <Icon name="Bot" className="size-3" />
      </span>
    );
  }
  const initial = (login.split("/").at(-1) ?? login).replace(/^@/u, "").charAt(0).toUpperCase() || "?";
  const slot = slotOf(login);
  return (
    <span aria-hidden data-avatar={slot} style={{ ...box, backgroundColor: `var(--ansi-${slot})`, color: `var(--ansi-bg-fg-${slot})`, fontSize: Math.round(size * 0.45) }}
      className={`inline-flex shrink-0 items-center justify-center font-bold leading-none ${team ? "rounded-md" : "rounded-full"}`}>
      {initial}
    </span>
  );
}
