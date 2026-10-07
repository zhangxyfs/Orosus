# -*- coding: utf-8 -*-
"""T12 onboarding 残余手工改线 + 缺键回填（表双件 + locale 三语）。"""
import io, re

# ---------- ① 缺键回填（表 + locale） ----------
new_ta = [
 "| onboard.p2.unconfigured | （未配置） | （未配置） | (not configured) | m5-i18n T12 新面回填 |",
 "| onboard.p2.setModelDone | 已写入 config.toml [provider]（provider = {id}） | 已寫入 config.toml [provider]（provider = {id}） | Written to config.toml [provider] (provider = {id}) | 同上 |",
 "| onboard.p2.keyFirst | 先输入 {name} 的 Key，再设为当前使用 | 先輸入 {name} 的 Key，再設為目前使用 | Enter the {name} key first, then set active | 同上 |",
 "| onboard.p4.writtenAuto | 已写入 config.toml [tool-web] search（用上一页配置的模型 · {name}，失败自动降级 Tavily / Brave） | 已寫入 config.toml [tool-web] search（用上一頁配置的模型 · {name}，失敗自動降級 Tavily / Brave） | Written to config.toml [tool-web] search (model from the previous page · {name}; falls back to Tavily / Brave) | 同上 |",
 "| onboard.p4.writtenPin | 已写入 config.toml [tool-web] search（钉住 {model}，失败自动降级 Tavily / Brave） | 已寫入 config.toml [tool-web] search（釘選 {model}，失敗自動降級 Tavily / Brave） | Written to config.toml [tool-web] search (pinned {model}; falls back to Tavily / Brave) | 同上 |",
 "| onboard.p5.noNotes | {label} 没有可导入的笔记 | {label} 沒有可匯入的筆記 | {label} has no notes to import | 同上 |",
 "| onboard.p5.imported | 已导入 {n} 条记忆（跳过 {skip} 条重复） | 已匯入 {n} 條記憶（跳過 {skip} 條重複） | Imported {n} memories ({skip} duplicates skipped) | 同上 |",
 "| onboard.dockNote | 焦点锁定在引导弹窗 · Esc 未占用 | 焦點鎖定在引導彈窗 · Esc 未佔用 | Focus locked to the onboarding dialog · Esc unused | 同上 |",
 "| onboard.foot.check | 勾选 | 勾選 | Check | 同上 |",
 "| onboard.foot.importDone | 导入选中并完成 | 匯入選中並完成 | Import selected and finish | 同上 |",
 "| onboard.foot.whyNoCheck | 未勾选则跳过导入 | 未勾選則跳過匯入 | Nothing checked — import skipped | 同上 |",
 "| onboard.p1.feat2.head | 任何提供商 | 任何提供商 | Any provider | 同上 |",
 "| onboard.p1.feat3.head | 目标驱动 | 目標驅動 | Goal-driven | 同上 |",
 "| onboard.p2.pasteHint | 粘贴 {name} 的 API Key（官网获取，输入不显示{conf}） | 貼上 {name} 的 API Key（官網取得，輸入不顯示{conf}） | Paste the {name} API key (from the vendor site; hidden as you type{conf}) | 同上 |",
 "| onboard.p2.pasteConf | ；已配置过，回车覆盖 | ；已配置過，Enter 覆蓋 | ; already configured — Enter overwrites | 同上 |",
 "| onboard.p2.typed | 已输入 {n} 字符 | 已輸入 {n} 字元 | {n} chars entered | 同上 |",
]
new_tb = [
 "| onboard.p2.unconfigured | （未配置） | （未設定） | (미설정) | (не настроен) | T12 新面 |",
 "| onboard.p2.setModelDone | 已写入 config.toml [provider]（provider = {id}） | config.toml [provider] に書き込み済み（provider = {id}） | config.toml [provider]에 기록됨(provider = {id}) | Записано в config.toml [provider] (provider = {id}) | 同上 |",
 "| onboard.p2.keyFirst | 先输入 {name} 的 Key，再设为当前使用 | 先に {name} の Key を入力してから現在使用に設定 | 먼저 {name}의 Key를 입력한 뒤 현재 사용으로 설정 | Сначала введите ключ {name}, затем сделайте активным | 同上 |",
 "| onboard.p4.writtenAuto | 已写入 config.toml [tool-web] search（用上一页配置的模型 · {name}，失败自动降级 Tavily / Brave） | config.toml [tool-web] search に書き込み済み（前ページのモデル · {name}、失敗時 Tavily / Brave へ自動降級） | config.toml [tool-web] search에 기록됨(이전 페이지 모델 · {name}, 실패 시 Tavily / Brave 자동 강등) | Записано в config.toml [tool-web] search (модель с прошлой страницы · {name}; при сбое откат на Tavily / Brave) | 同上 |",
 "| onboard.p4.writtenPin | 已写入 config.toml [tool-web] search（钉住 {model}，失败自动降级 Tavily / Brave） | config.toml [tool-web] search に書き込み済み（{model} を固定、失敗時 Tavily / Brave へ自動降級） | config.toml [tool-web] search에 기록됨({model} 고정, 실패 시 Tavily / Brave 자동 강등) | Записано в config.toml [tool-web] search (закреплено {model}; при сбое откат на Tavily / Brave) | 同上 |",
 "| onboard.p5.noNotes | {label} 没有可导入的笔记 | {label} にインポート可能なノートなし | {label}에 가져올 노트가 없어요 | В {label} нет заметок для импорта | 同上 |",
 "| onboard.p5.imported | 已导入 {n} 条记忆（跳过 {skip} 条重复） | {n} 件のメモリをインポート済み（{skip} 件の重複をスキップ） | 메모리 {n}건 가져옴({skip}건 중복 건너뜀) | Импортировано записей: {n} (пропущено дублей: {skip}) | 同上 |",
 "| onboard.dockNote | 焦点锁定在引导弹窗 · Esc 未占用 | フォーカスはオンボーディング弾窗に固定 · Esc 未使用 | 포커스가 온보딩 창에 고정 · Esc 미사용 | Фокус заблокирован в диалоге онбординга · Esc свободен | 同上 |",
 "| onboard.foot.check | 勾选 | チェック | 선택 | Отметить | 同上 |",
 "| onboard.foot.importDone | 导入选中并完成 | 選択項目をインポートして完了 | 선택 항목 가져오고 완료 | Импортировать выбранное и завершить | 同上 |",
 "| onboard.foot.whyNoCheck | 未勾选则跳过导入 | 未チェックならインポートをスキップ | 선택 안 하면 가져오기 건너뜀 | Ничего не отмечено — импорт пропускается | 同上 |",
 "| onboard.p1.feat2.head | 任何提供商 | どのプロバイダでも | 모든 공급자 | Любой провайдер | 同上 |",
 "| onboard.p1.feat3.head | 目标驱动 | ゴール駆動 | 목표 주도 | Целевой режим | 同上 |",
 "| onboard.p2.pasteHint | 粘贴 {name} 的 API Key（官网获取，输入不显示{conf}） | {name} の API Key を貼り付け（公式サイトで取得、入力は非表示{conf}） | {name}의 API Key 붙여넣기(공식 사이트에서 획득, 입력 미표시{conf}) | Вставьте API-ключ {name} (с сайта вендора; ввод скрыт{conf}) | 同上 |",
 "| onboard.p2.pasteConf | ；已配置过，回车覆盖 | ；設定済み、Enter で上書き | ; 이미 설정됨, Enter로 덮어쓰기 | ; уже настроен — Enter перезапишет | 同上 |",
 "| onboard.p2.typed | 已输入 {n} 字符 | {n} 文字入力済み | {n}자 입력됨 | Введено символов: {n} | 同上 |",
]
for path, rows in [("docs/superpowers/specs/i18n-translations/ta-zone-c-3.md", new_ta), ("docs/superpowers/specs/i18n-translations/tb-zone-c-3.md", new_tb)]:
    s = io.open(path, encoding="utf-8").read()
    added = [r for r in rows if r.split("|")[1].strip() + " " not in s]
    if not added:
        continue
    idx = s.find("| onboard.p2.keyHint ")
    assert idx >= 0, path
    le = s.find("\n", idx) + 1
    s = s[:le] + "\n".join(added) + "\n" + s[le:]
    io.open(path, "w", encoding="utf-8", newline="\n").write(s)
    print(path.split("/")[-1], "+", len(added))

# ---------- ② tui/onboarding.ts 手工改线 ----------
p = "apps/cli/src/tui/onboarding.ts"
s = io.open(p, encoding="utf-8").read()
R = [
 ('    return this.p2.active === null ? "（未配置）" : this.provById(this.p2.active).name;',
  '    return this.p2.active === null ? t("onboard.p2.unconfigured") : this.provById(this.p2.active).name;'),
 ('        this.notice(`已写入 config.toml [provider]（provider = ${prov.id}）`, "ok");',
  '        this.notice(t("onboard.p2.setModelDone", { id: prov.id }), "ok");'),
 ('        this.notice(`先输入 ${prov.name} 的 Key，再设为当前使用`, "warn");',
  '        this.notice(t("onboard.p2.keyFirst", { name: prov.name }), "warn");'),
 ('        this.notice(`Key 已写入 secrets.env（${envKey}）——${prov.name} 备用（Space 设为当前使用）`, "ok");',
  '        this.notice(t("onboard.p2.keyWrittenBackup", { envKey, name: prov.name }), "ok");'),
 ('        this.notice(`已指定视觉模型 ${m}`, "ok");',
  '        this.notice(t("onboard.vision.picked", { model: m }), "ok");'),
 ('          this.notice(`已写入 config.toml [tool-web] search（用上一页配置的模型 · ${this.activeName()}，失败自动降级 Tavily / Brave）`, "ok");',
  '          this.notice(t("onboard.p4.writtenAuto", { name: this.activeName() }), "ok");'),
 ('    this.notice(`已写入 config.toml [tool-web] search（钉住 ${qualified}，失败自动降级 Tavily / Brave）`, "ok");',
  '    this.notice(t("onboard.p4.writtenPin", { model: qualified }), "ok");'),
 ('        if (!src.available || src.count === 0) { this.notice(`${src.label} 没有可导入的笔记`, "warn"); return undefined; }',
  '        if (!src.available || src.count === 0) { this.notice(t("onboard.p5.noNotes", { label: src.label }), "warn"); return undefined; }'),
 ('        this.notice(`已导入 ${r.imported} 条记忆（跳过 ${r.skipped} 条重复）`, "ok");',
  '        this.notice(t("onboard.p5.imported", { n: r.imported, skip: r.skipped }), "ok");'),
 ('    const step = theme.fg("info", `引导 ${this.page} / ${PAGE_TITLES.length}`);',
  '    const step = theme.fg("info", t("onboard.step", { page: this.page, total: PAGE_TITLES.length }));'),
 ('    const note = theme.dim("焦点锁定在引导弹窗 · Esc 未占用");',
  '    const note = theme.dim(t("onboard.dockNote"));'),
 ('    if (this.page === 1) return this.foot([{ key: "Ctrl + Q", label: "退出", on: true }, { key: "Ctrl + N", label: "下一步", on: true }], inner);',
  '    if (this.page === 1) return this.foot([{ key: "Ctrl + Q", label: t("onboard.foot.quit"), on: true }, { key: "Ctrl + N", label: t("onboard.foot.next"), on: true }], inner);'),
 ('''      return this.foot([
        { key: "Space", label: "设为当前使用", on: true },
        { key: "Ctrl + N", label: "下一步", on: ready, why: ready ? "" : "先配好一家提供商" },
      ], inner);''',
  '''      return this.foot([
        { key: "Space", label: t("onboard.foot.setActive"), on: true },
        { key: "Ctrl + N", label: t("onboard.foot.next"), on: ready, why: ready ? "" : t("onboard.foot.whyNoProvider") },
      ], inner);'''),
 ('    if (this.page === 3) return this.foot([{ key: "Ctrl + N", label: "下一步", on: true }], inner);',
  '    if (this.page === 3) return this.foot([{ key: "Ctrl + N", label: t("onboard.foot.next"), on: true }], inner);'),
 ('''      return this.foot([
        { key: "Ctrl + N", label: "下一步", on: ready, why: ready ? "" : "先选定后端——LLM 回车即选" },
      ], inner);''',
  '''      return this.foot([
        { key: "Ctrl + N", label: t("onboard.foot.next"), on: ready, why: ready ? "" : t("onboard.foot.whyNoBackend") },
      ], inner);'''),
 ('''    return this.foot([
      { key: "Space", label: "勾选", on: true },
      { key: "Ctrl + N", label: "导入选中并完成", on: !this.pm.importing, why: this.pm.importing ? "导入中…" : this.pm.checked.size === 0 ? "未勾选则跳过导入" : "" },
    ], inner);''',
  '''    return this.foot([
      { key: "Space", label: t("onboard.foot.check"), on: true },
      { key: "Ctrl + N", label: t("onboard.foot.importDone"), on: !this.pm.importing, why: this.pm.importing ? t("onboard.foot.whyImporting") : this.pm.checked.size === 0 ? t("onboard.foot.whyNoCheck") : "" },
    ], inner);'''),
 ('    feat("联网能力", t("onboard.p1.feat1.body"));\n    feat("任何提供商", t("onboard.p1.feat2.body"));\n    feat("目标驱动", t("onboard.p1.feat3.body"));',
  '    feat(t("onboard.p1.feat1.head"), t("onboard.p1.feat1.body"));\n    feat(t("onboard.p1.feat2.head"), t("onboard.p1.feat2.body"));\n    feat(t("onboard.p1.feat3.head"), t("onboard.p1.feat3.body"));'),
 ('    const marks = `${done ? theme.fg("accent", "✓") : " "}${active === true ? ` ${theme.fg("accent", "[使用中]")}` : ""}`;',
  '    const marks = `${done ? theme.fg("accent", "✓") : " "}${active === true ? ` ${theme.fg("accent", t("onboard.p2.activeMark"))}` : ""}`;'),
 ('        out.push(theme.dim(`粘贴 ${prov.name} 的 API Key（官网获取，输入不显示${conf ? "；已配置过，回车覆盖" : ""}）`));',
  '        out.push(theme.dim(t("onboard.p2.pasteHint", { name: prov.name, conf: conf ? t("onboard.p2.pasteConf") : undefined })));'),
 ('      out.push(`${theme.fg("accent", "▍")} ${draft === "" ? theme.dim(t("onboard.blindPlaceholder")) : theme.fg("fg", `已输入 ${draft.length} 字符`)}`);',
  '      out.push(`${theme.fg("accent", "▍")} ${draft === "" ? theme.dim(t("onboard.blindPlaceholder")) : theme.fg("fg", t("onboard.p2.typed", { n: draft.length }))} `);'),
]
applied = 0
for old, new in R:
    if s.count(old) == 1:
        s = s.replace(old, new)
        applied += 1
    else:
        print("MISS:", old[:48])
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("tui/onboarding applied", applied)
