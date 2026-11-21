// Git calls these files binary, but a picture is the review's best diff: the card renders each side as an image.
const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

const extensionOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

export const isImagePath = (path: string): boolean => extensionOf(path) in MEDIA_TYPES;

export const mediaTypeOfPath = (path: string): string => MEDIA_TYPES[extensionOf(path)] ?? "application/octet-stream";

export const dataUrlOf = (path: string, base64: string): string => `data:${mediaTypeOfPath(path)};base64,${base64}`;

// Two base64-encoded sides and the JSON fields must fit the host RPC's 8 MiB response limit.
export const IMAGE_LIMIT = 3 * 1024 * 1024 - 1024;
