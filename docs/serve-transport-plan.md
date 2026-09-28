# `--serve` 实施方案（transport half）

> 依据：issue #56 维护者回复 · 本机实测（Edge 151 / Windows / node v24.18.1）
> 范围：**只做 transport**，不碰 lifecycle

---

## 0. 目标与非目标

### 目标

在 vendored CLI 上加一个 `--serve` 模式，让插件能用一个**常驻进程**处理多次调用，
消除每次 `ego_*` 调用的 ~350ms spawn 开销（实测常驻可降至 ~8ms）。

### 非目标（维护者明确划走）

- ❌ 插件侧 spawn/supervise/reap 策略
- ❌ idle reaper、崩溃恢复、settings 开关
- ❌ 改动 `runEgoScript` 的调用方
- ❌ **改动 `runtime/ego-browser/dist/`**（vendored bundle 保持原样）
- ❌ 改动 `parseSentinel` 及 `src/index.ts` 的读取路径

---

## 1. 协议设计（依据维护者的纠正）

### 1.1 帧格式：**只传输原始流**

维护者纠正了我最初的方案（在协议行上放 sentinel）。**sentinel 不是 runner 写的**，
是插件生成的脚本自己 `console.log` 的。若 runner 也打 sentinel，它就得自己实现
last-wins，且脚本打印的 sentinel 形状文本会被误认（验证码误报就是这么来的）。

```
--> {"id":"1","code":"<heredoc 原文>"}
<-- {"id":"1","ok":true,"stdout":"<脚本 stdout 原文>","stderr":"<stderr 原文>"}
```

客户端 unescape `stdout` 后交给**现有** `parseSentinel` —— 字节级等同一次性路径。

**为什么这样就没有冲突面**：sentinel 形状文本在 JSON 字符串里**只是数据**。

### 1.2 失败帧

```
<-- {"id":"1","ok":false,"error":"<消息>","stdout":"...","stderr":"..."}
```

客户端据此合成与 spawn 路径**相同**的 `{exitCode, stdout, stderr}`，
使 `runEgoScript` 的 interpret 部分无需改动，错误字符串保持一致。

### 1.3 `id` 匹配

当前插件已用锁串行化 ego 调用，但 `id` 让未来放松串行化时无需改协议。

---

## 2. 必须解决的三个陷阱（维护者指出 + 我已实测验证）

### ❷ `console.log` 被永久劫持 —— 已实测确认

`executionContext()` 把 `console.log` 重指向 sink：

```
实测：调用后执行 console.log('PROTOCOL-LINE')
     → 该行消失（未出现在 stderr），被吞进 sink
```

**所以：启动时捕获 `process.stdout.write`，用它写协议行。绝不用 `console.log`。**

### ❶ `globalThis` 快照必须记录**值**，不能只记键 —— 已实测确认

```
实测：脚本执行 globalThis.fetch = function(){return "POISONED"}
     键数 before=15 after=15  差=0        ← 键集合没变
     fetch() → "POISONED"                ← 但值被污染
```

**方案**：`new Map(Object.entries(globalThis))` 快照（~80 个引用，无深拷贝），
调用后：删除新键 + **恢复被改键的原值**。

### ❸ shim 持有活的 CDP socket —— 已实测，但发现现状比预期复杂

```
实测：stopBrowser() 后调用 listTabs()
     旧 shim        → n=0（静默，无异常）
     一次性路径新进程 → n=0（同样静默，545ms）
```

**关键发现：这是【既有】行为，不是常驻进程引入的回归。**

- 但常驻进程会**放大**它：一次断线后**所有后续调用**都静默错误
  （一次性路径每次都会重新探测浏览器）
- **检测不能依赖异常**（assertOpen 未触发）
- 需**主动健康检查**（`chrome.mjs` 的 `probe(port)` 或 `browserStatus()`）

> ⚠️ **这一条超出 transport 范围**：把"静默 n=0"改成"重连或明确报错"是对
> **既有行为**的改善，影响一次性路径。我会在 PR 里标注，由维护者决定
> 是否纳入本次改动。

---

## 3. 实现结构

### 3.1 插入点

`runtime/ego-linux/bin/ego-browser.mjs` 的 `main()`，在 `--stop` 之后加：

```js
if (argv[0] === "--serve") return serve();
```

并在 `USAGE` 里加一行说明。

### 3.2 `serve()` 骨架

```js
async function serve() {
  // 必须在任何脚本执行前捕获，之后 console.log 会被劫持
  const write = process.stdout.write.bind(process.stdout);

  const shim = await createEgoShim({ headless });
  globalThis.ego = shim.ego;
  const { runMain } = await import(harness);

  for await (const line of readLines(process.stdin)) {
    const req = JSON.parse(line);          // 坏行 → 回错误帧，不崩
    const snapshot = new Map(Object.entries(globalThis));
    const out = createCapture(), err = createCapture();
    let ok = true, error;
    try {
      await runMain({ argv: [], stdinText: req.code, stdout: out, stderr: err });
    } catch (e) {
      ok = false; error = String(e?.message ?? e);
    }
    restoreGlobals(snapshot);              // 删新键 + 恢复旧值
    write(JSON.stringify({ id: req.id, ok,
      ...(ok ? {} : { error }),
      stdout: out.text(), stderr: err.text() }) + '\n');
  }
}
```

### 3.3 `restoreGlobals(snapshot)`

```js
function restoreGlobals(before) {
  for (const key of Object.keys(globalThis)) {
    if (!before.has(key)) { try { delete globalThis[key] } catch {} }
  }
  for (const [key, value] of before) {
    if (!Object.is(globalThis[key], value)) {
      try { globalThis[key] = value } catch {}
    }
  }
}
```

**注意**：`ego` 会被 restore 删掉（它是 setup 时注入的）——
所以 `globalThis.ego` 的赋值要在**每次请求后重新确认**，或把它排除在还原之外。
这是实现时必须处理的一个细节。

---

## 4. 测试计划

维护者要求的 6 项 + 我原计划的 4 项：

| # | 测试 | 来源 |
|---|---|---|
| 1 | 分帧往返（请求→响应） | 我 |
| 2 | 按 id 排序/匹配 | 我 |
| 3 | 抛出脚本 → `ok:false` + error，流不坏 | 我 |
| 4 | 泄漏全局 → 下次调用不可见 | 我 |
| 5 | **覆盖型污染**（`globalThis.fetch=...`）→ 值被还原 | 维护者 ❶ |
| 6 | **sentinel 形状文本不误判** | 维护者 |
| 7 | **浏览器停后重连**（或明确失败） | 维护者 ❸ |
| 8 | 多请求连续（≥20 次）无状态累积 | 我 |
| 9 | 坏 JSON 行 → 错误帧，进程不崩 | 我 |
| 10 | `console.log` 写协议会被吞（回归保护） | 维护者 ❷ |

---

## 5. 验收标准

- 全部测试通过
- `pnpm run typecheck` / `test` / `build` 通过
- **实测延迟**：常驻进程单次调用 ~8ms（对比 spawn 路径 350ms）
- **不改动** `runtime/ego-browser/dist/`（`git diff` 可证）
- **不改动** `src/index.ts`

---

## 6. 交付

一个 PR，只碰：
- `runtime/ego-linux/bin/ego-browser.mjs`（`--serve` + USAGE）
- `tests/`（新增测试文件）

CI 通过后提 PR，引用 issue #56，并在描述里标注第 3 节 ❸ 的范围问题。
