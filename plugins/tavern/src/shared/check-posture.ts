export function reviewLimitation(posture: "independent" | "same-family" | "not-established" | undefined): string | null {
  return posture === "same-family" ? "same-family check (not independent)" : posture === "not-established" ? "check independence not established" : null;
}
