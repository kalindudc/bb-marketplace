// A phone, or a Loom page under 36rem: where the ticket docks its answer and the map turns into a picture. Measured in
// script, not by a container query, because the two layouts render different elements.
import { useLayoutEffect, useState, type RefObject } from "react";

/** Inputs at 16 px on a phone, so focusing one does not zoom the page; 16 px, not 1rem, since bb's root is 15 px. */
export const PHONE_TEXT = "@max-xl/loom:text-[16px] max-[576px]:text-[16px]";

/** True while the Loom page around `ref` is phone-sized; again on every resize. */
export function useNarrowPage(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null || typeof window === "undefined") return;
    const page = node.closest<HTMLElement>("[data-loom-scroll]");
    const measure = () => setNarrow(window.innerWidth <= 576 || (page?.clientWidth || window.innerWidth) < 576);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (page !== null) observer?.observe(page);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return narrow;
}

/** True on a touch screen (a coarse pointer), at any width: where decision 13 asks for 44 px targets beyond phones. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useLayoutEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(pointer: coarse)");
    const measure = () => setCoarse(query.matches);
    measure();
    query.addEventListener?.("change", measure);
    return () => query.removeEventListener?.("change", measure);
  }, []);
  return coarse;
}
