import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, resolveConfig } from "./config.js";

const existsIn =
  (paths: string[]) =>
  (p: string): boolean =>
    paths.includes(p);

test("resolveConfig: --config 存在时优先级最高（压过环境变量与默认路径）", () => {
  const r = resolveConfig({
    cliArg: "/tmp/a.json",
    env: "/tmp/b.json",
    defaultPath: "/tmp/d.json",
    exists: existsIn(["/tmp/a.json"]),
  });
  assert.deepEqual(r, { status: "found", path: "/tmp/a.json", source: "cli" });
});

test("resolveConfig: --config 缺失时报 explicit-missing（不静默回退）", () => {
  const r = resolveConfig({
    cliArg: "/tmp/a.json",
    env: "/tmp/b.json",
    defaultPath: "/tmp/d.json",
    exists: existsIn(["/tmp/b.json", "/tmp/d.json"]),
  });
  assert.deepEqual(r, { status: "explicit-missing", path: "/tmp/a.json" });
});

test("resolveConfig: 无 --config 时取 MAXTOKEN_CONFIG 环境变量", () => {
  const r = resolveConfig({
    env: "/tmp/b.json",
    defaultPath: "/tmp/d.json",
    exists: existsIn(["/tmp/b.json"]),
  });
  assert.deepEqual(r, { status: "found", path: "/tmp/b.json", source: "env" });
});

test("resolveConfig: 环境变量指向的文件缺失时报 explicit-missing", () => {
  const r = resolveConfig({
    env: "/tmp/b.json",
    defaultPath: "/tmp/d.json",
    exists: existsIn(["/tmp/d.json"]),
  });
  assert.deepEqual(r, { status: "explicit-missing", path: "/tmp/b.json" });
});

test("resolveConfig: 默认路径存在时自动加载", () => {
  const r = resolveConfig({
    defaultPath: "/tmp/d.json",
    exists: existsIn(["/tmp/d.json"]),
  });
  assert.deepEqual(r, { status: "found", path: "/tmp/d.json", source: "default" });
});

test("resolveConfig: 默认路径缺失时报 default-missing", () => {
  const r = resolveConfig({
    defaultPath: "/tmp/d.json",
    exists: existsIn([]),
  });
  assert.deepEqual(r, { status: "default-missing", path: "/tmp/d.json" });
});

test("resolveConfig: 相对路径被解析为绝对路径", () => {
  const abs = path.resolve("tokens.json");
  const r = resolveConfig({
    cliArg: "tokens.json",
    exists: existsIn([abs]),
  });
  assert.deepEqual(r, { status: "found", path: abs, source: "cli" });
});

// ==================== loadConfig 测试 ====================
function tempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxtoken-test-"));
  const file = path.join(dir, "tokens.json");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

test("loadConfig: 合法配置正常加载", () => {
  const file = tempConfig(
    JSON.stringify({
      accounts: [
        { id: "glm-main", provider: "glm", api_key: "k1" },
        { id: "kimi-main", provider: "kimi", api_key: "k2" },
      ],
    })
  );
  const cfg = loadConfig(file);
  assert.equal(cfg.accounts.length, 2);
});

test("loadConfig: 文件缺失时报含引导的错误", () => {
  assert.throws(() => loadConfig("/definitely/not/here/tokens.json"), /未找到配置文件/);
});

test("loadConfig: 缺少 accounts 数组报错", () => {
  assert.throws(() => loadConfig(tempConfig('{"foo": 1}')), /缺少 accounts 数组/);
});

test("loadConfig: JSON 语法错误报错", () => {
  assert.throws(() => loadConfig(tempConfig("{not json")), /JSON 语法错误/);
});

test("loadConfig: 缺 id 与非法 provider 逐条报错", () => {
  const file = tempConfig(
    JSON.stringify({ accounts: [{ provider: "openai", api_key: "k1" }] })
  );
  assert.throws(
    () => loadConfig(file),
    (err: any) =>
      err.message.includes("accounts[0]: 缺少 id") &&
      err.message.includes("accounts[0]: provider 必须为 glm 或 kimi")
  );
});

test("loadConfig: 缺 api_key 逐条报错", () => {
  const file = tempConfig(JSON.stringify({ accounts: [{ id: "a", provider: "glm" }] }));
  assert.throws(() => loadConfig(file), /accounts\[0\]: 缺少 api_key/);
});
