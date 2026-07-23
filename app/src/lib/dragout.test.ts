import { describe, expect, it } from "vitest";
import { downloadUrlSpec } from "./dragout";

describe("downloadUrlSpec", () => {
  it("mime・ファイル名・URLをコロン区切りで組み立てる", () => {
    expect(downloadUrlSpec("image/png", "サポートノート-画像-abc123.png", "blob:http://localhost/xyz")).toBe(
      "image/png:サポートノート-画像-abc123.png:blob:http://localhost/xyz"
    );
  });

  it("mimeやファイル名が変わっても同じ形式（mime:filename:url）を保つ", () => {
    expect(downloadUrlSpec("image/jpeg", "file.jpg", "blob:abc")).toBe("image/jpeg:file.jpg:blob:abc");
  });
});
