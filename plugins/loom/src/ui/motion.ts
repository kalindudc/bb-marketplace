// How the page moves to what a jump names: smoothly, or at once when the person asked for reduced motion. The shared
// reduced-motion CSS cannot stop a smooth scroll started from script, so every jump asks here.
export function jumpBehavior(): ScrollBehavior {
  const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduced ? "auto" : "smooth";
}
