// jsdom has no IntersectionObserver; running spinners observe their visibility with one.
if (!("IntersectionObserver" in globalThis)) {
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
}
