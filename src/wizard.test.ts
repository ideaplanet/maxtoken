import test from "node:test";
import assert from "node:assert/strict";
import { suggestId } from "./wizard.js";

test("suggestId: 无冲突时返回 {provider}-main", () => {
  assert.equal(suggestId(["kimi-main"], "glm"), "glm-main");
});

test("suggestId: 主 id 被占用时追加 -2", () => {
  assert.equal(suggestId(["glm-main"], "glm"), "glm-main-2");
});

test("suggestId: 连续占用时递增编号", () => {
  assert.equal(suggestId(["glm-main", "glm-main-2", "kimi-main"], "glm"), "glm-main-3");
});
