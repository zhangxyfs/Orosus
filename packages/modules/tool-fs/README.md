# tool-fs

- **提供**：能力 `fs`（本地实现，路径限根目录内）；工具 `tool-fs__read` / `tool-fs__write` / `tool-fs__edit` / `tool-fs__glob`（glob 模式找文件，只返回文件不含目录）/ `tool-fs__grep`（内容正则搜索，跳过 >1MB 文件、命中上限 200）
- **消费**：无
- **配置**：无（M1 根目录 = 进程 cwd）
