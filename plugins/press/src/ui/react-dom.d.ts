declare module "react-dom" {
  export function createPortal(
    children: import("react").ReactNode,
    container: Element | DocumentFragment,
  ): import("react").ReactPortal;
}
