---
description: ClaudeCodeToaster 音效提醒控制：测试音效、总开关、仅 bypass 模式开关、自定义音效文件、音量、预设、重置
argument-hint: "[test [success|fail|abort] | toggle | bypass-only | set <success|fail|abort> <音频文件路径> | volume <success|fail|abort> <0-100> | preset <simple|crisp|tech> | reset <success|fail|abort|all> | status]"
disable-model-invocation: true
allowed-tools: Bash
---

# ClaudeCodeToaster 音效控制

用户调用了本命令，传入参数为：`$ARGUMENTS`（可能为空）。

请立即使用 Bash 工具执行下面这一条命令，不要改写其中的路径、不要省略参数、不要先做其他动作：

- 将 `$ARGUMENTS` 原样追加在命令末尾（若为空则不追加）。
- 执行完成后，把命令的标准输出原样展示给用户；若输出为空或报错，如实告知用户输出内容。
- 不要自行解释音效配置，一切以该命令的输出为准。

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/index.js" sound $ARGUMENTS
```
