import { describe, expect, it } from "vitest";
import { tagMetadataKey } from "../../src/index";

describe("tagMetadataKey", () => {
  it("passes clean tags through", () => {
    expect(tagMetadataKey("magazine-hub")).toBe("tag_magazine-hub");
    expect(tagMetadataKey("kind:episodic")).toBe("tag_kind:episodic");
  });
  it("replaces dots and quotes (VECTOR_INSERT_ERROR 40018 regression)", () => {
    expect(tagMetadataKey("1.0")).toBe("tag_1_0");
    expect(tagMetadataKey('a"b')).toBe("tag_a_b");
  });
  it("strips leading dollar signs", () => {
    expect(tagMetadataKey("$$secret")).toBe("tag_secret");
  });
  it("rejects tags that sanitize to nothing or exceed the key byte limit", () => {
    expect(tagMetadataKey("$")).toBeNull();
    expect(tagMetadataKey("")).toBeNull();
    expect(tagMetadataKey("あ".repeat(200))).toBeNull();
  });
});
