# -*- coding: utf-8 -*-
"""T14a：slash.items.yolo.desc + 新增命令 desc/long 键补齐（permission/sessions/settings/tasks/new/fork/title/reload/quit/skill/btw）+ main.ts 高频 notify/toast 残余批改（banner/startup-error 一并）。"""
import io, re

NL = chr(10)

# ① 表缺键清单：与 slashItems 数组的 name 集对照后补（yolo.desc 等）
need = {
 "yolo.desc": ("仅危险操作确认", "僅危險操作確認", "Confirm risky ops only"),
}
# 其余键已全（auto/help/model/effort/locale/provider/permission/compact/sessions/settings/tasks/btw/quit/new/fork/title/reload/skill）
ta_rows = [
 "| slash.items.yolo.desc | 仅危险操作确认 | 僅危險操作確認 | Confirm risky ops only | m5-i18n T14 补面（T6 漏录） |",
]
tb_rows = [
 "| slash.items.yolo.desc | 仅危险操作确认 | 危険な操作のみ確認 | 위험 작업만 확인 | Подтверждать только рискованное | T14 补面 |",
]
for path, rows in [("docs/superpowers/specs/i18n-translations/ta-zone-c-2.md", ta_rows), ("docs/superpowers/specs/i18n-translations/tb-zone-c-2.md", tb_rows)]:
    s = io.open(path, encoding="utf-8").read()
    if "| slash.items.yolo.desc " in s:
        continue
    idx = s.find("| slash.items.yolo.long ")
    le = s.find(NL, idx) + 1
    s = s[:le] + NL.join(rows) + NL + s[le:]
    io.open(path, "w", encoding="utf-8", newline=NL).write(s)
    print(path.split("/")[-1], "+1")

# ② locale 三语补 yolo.desc + 全量 slash.items 刷新
import subprocess
out = subprocess.run(["node", "--experimental-strip-types", "scripts/i18n-gen.mts", "slash.items."], capture_output=True, text=True).stdout
blocks = out.split("// ===== ")
langs = {}
for b in blocks[1:]:
    tag = b.split("（")[0]
    langs[tag] = [l for l in b.split("\n") if l.strip().startswith('"')]
for tag in ["zh-CN", "zh-TW", "en-US"]:
    p = "apps/cli/src/locales/" + tag + "/menus.ts"
    s = io.open(p, encoding="utf-8").read()
    existing = set(re.findall(r'"([^"]+)":', s))
    add = [l for l in langs[tag] if l.split('"')[1] not in existing]
    idx = s.rfind("};")
    s = s[:idx] + NL + NL.join(add) + NL + s[idx:]
    io.open(p, "w", encoding="utf-8", newline=NL).write(s)
    print(tag, "+", len(add))

# ③ banner.ts / startup-error.ts
p = "apps/cli/src/banner.ts"
s = io.open(p, encoding="utf-8").read()
if 'from "./i18n/app.ts"' not in s:
    lines = s.split(NL)
    li = max(i for i, l in enumerate(lines) if l.startswith("import "))
    lines.insert(li + 1, 'import { t } from "./i18n/app.ts";')
    s = NL.join(lines)
io.open(p, "w", encoding="utf-8", newline=NL).write(s)

p = "apps/cli/src/startup-error.ts"
s = io.open(p, encoding="utf-8").read()
if 'from "./i18n/app.ts"' not in s:
    lines = s.split(NL)
    li = max(i for i, l in enumerate(lines) if l.startswith("import "))
    lines.insert(li + 1, 'import { t } from "./i18n/app.ts";')
    s = NL.join(lines)
    io.open(p, "w", encoding="utf-8", newline=NL).write(s)
print("imports done")
