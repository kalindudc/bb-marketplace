import { describe, expect, it } from "vitest";
import { dataUrlOf, isImagePath, mediaTypeOfPath } from "../src/images";

describe("image paths", () => {
  it("recognises the picture extensions, whatever their case or folder", () => {
    expect(isImagePath("screenshots/overview.PNG")).toBe(true);
    expect(isImagePath("docs/img/photo.jpeg")).toBe(true);
    expect(isImagePath("logo.svg")).toBe(true);
    expect(isImagePath("icon.ico")).toBe(true);
  });

  it("leaves every other file alone", () => {
    expect(isImagePath("src/a.ts")).toBe(false);
    expect(isImagePath("notes.txt")).toBe(false);
    expect(isImagePath("archive.tar")).toBe(false);
    expect(isImagePath("no-extension")).toBe(false);
    expect(isImagePath("folder.hidden/file")).toBe(false);
    expect(isImagePath("weird.name.png")).toBe(true);
  });

  it("maps each extension to its media type", () => {
    expect(mediaTypeOfPath("a.png")).toBe("image/png");
    expect(mediaTypeOfPath("a.JPG")).toBe("image/jpeg");
    expect(mediaTypeOfPath("a.svg")).toBe("image/svg+xml");
    expect(mediaTypeOfPath("a.txt")).toBe("application/octet-stream");
  });

  it("builds a data URL a browser renders as an image", () => {
    expect(dataUrlOf("a.png", "QUJD")).toBe("data:image/png;base64,QUJD");
  });
});
