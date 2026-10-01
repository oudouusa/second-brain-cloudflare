import { describe, expect, it } from "vitest";
import { publicationProblems } from "../../scripts/check-publication.mjs";

const config = () => ({ d1_databases: [{ binding: "DB" }], kv_namespaces: [{ binding: "OAUTH_KV" }],
  vars: { CHATGPT_OPERATIONS: "", CHATGPT_OWNER_WORKSPACE_ID: "" }, secrets: { required: ["AUTH_TOKEN"] } });
const tree = (value = config()) => new Map([
  ["wrangler.jsonc", JSON.stringify(value)],
  [".github/workflows/installer-release.yml", "permissions:\n  contents: read\njobs:\n  disabled:\n    if: ${{ false }}\n"],
  [".dev.vars.example", "AUTH_TOKEN=placeholder"],
]);

describe("公開用treeの境界", () => {
  it("資産IDなし・生成OFF・資格情報サンプルだけのtreeを受け入れる", () => {
    expect(publicationProblems(tree())).toEqual([]);
  });
  it.each([".env.production", ".dev.vars.local", "oauth/pending.json", "oauth/registration.json", "owner.cred",
    "docs/fork/archive/DEPLOYMENT_HISTORY.md"])("%sが追跡された場合に拒否する", path => {
    const files = tree(); files.set(path, "値を検査出力へ出さない");
    expect(publicationProblems(files).some(error => error.startsWith(path))).toBe(true);
  });
  it("共通設定への資産ID・所有者設定・秘密情報の再混入を拒否する", () => {
    const value = { ...config(), account_id: "00000000000000000000000000000000",
      vars: { CHATGPT_OPERATIONS: "answer", CHATGPT_OWNER_WORKSPACE_ID: "example-owner", AUTH_TOKEN: "placeholder" } };
    expect(publicationProblems(tree(value))).toHaveLength(3);
  });
  it("手動タグリリースの経路を復活させた場合に拒否する", () => {
    const files = tree();
    files.set(".github/workflows/installer-release.yml", "permissions:\n  contents: write\nwith:\n  tagName: installer-v-example\n");
    expect(publicationProblems(files)).toContain("installer workflow: 独自配布は未対応です");
  });
});
