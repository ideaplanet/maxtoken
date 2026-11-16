import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveConfig } from "./config.js";

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
