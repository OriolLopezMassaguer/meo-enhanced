# Markdown 行内样式

内容样式的共同定义位于 `src/shared/markdownInlineStyles.ts`。当前集中管理粗体、
斜体、删除线、下标和上标；修改字重、字号比例、行高或对齐时在这里修改。

- Live/Source：`webview/src/helpers/inlineStyles.ts` 把共享样式绑定到 CodeMirror 类名。
- Preview 和导出：`src/export/exportStyles.ts` 把相同定义绑定到 HTML 元素。
- 标记显隐、光标、选区、语法着色以及既有模式专用颜色由各自适配层管理。

上下标的共同判定位于 `src/foundation/inlineScript.ts`，由 Lezer、Live 表格和
Preview/导出的 Markdown-it 适配器调用。`~文字~` 是下标，`^文字^` 是上标，
`~~文字~~` 是删除线。上下标内容按文字处理，空白必须转义；代码里的标记保持原文。

选区包裹规则位于 `webview/src/application/symbolInput.ts`。`^` 和 `=` 与其他标记
共用“选中文字后包裹符号”开关。一次输入只包一层，并保留内部选区：一次 `=`
得到 `=文字=`，再输入一次才得到高亮 `==文字==`；空光标保持普通字符输入。

其他行内/块级样式仍使用既有定义，在对应功能改动时逐步接入共享来源。

修改后运行 `bun scripts/test-preview-rendering.ts` 和 `bun scripts/test-highlight.ts`。
两项共享同一组行为样例，验证实际渲染、转义、表格、模式切换和基础样式。

## CriticMarkup

`{++增加++}`、`{--删除--}`、`{~~旧~>新~~}`、`{==标记==}`、`{>>批注<<}`。
共同判定位于 `src/foundation/criticMarkup.ts`（`matchCriticMarkup`），由 Lezer
(`webview/src/helpers/criticMarkupSyntax.ts`) 和 Preview/导出的 Markdown-it 适配器
(`src/export/criticMarkupTransform.ts`) 调用。内容按文字处理；没有结束符或内容为空时保持原文；
代码和反斜杠转义里的标记保持原文。替换由整体解析，因此其中的 `~~` 不会与删除线配对。

- Live：分隔符在非活动行隐藏；内容使用 `meo-md-critic-*` 类。
- Source：保留所有字符，只给内容和分隔符着色（`sourceCriticField`）。
- Preview/导出：`critic-add`、`critic-del`、`critic-hl`、`critic-comment` 四个 `span`，样式在 `exportStyles.ts`。
  跨块标记（例如列表前的 `{==` 和列表后的 `==}`）由 core 规则 `meo_critic_cross_block` 拆成每块一个 `span`，
  HTML 保持合法，源码行号不变；跨块批注显示为带样式的文字，不生成编号批注。
- Live 表格：单元格内的标记由 `parseTableInlineSyntax` 的 `critics` 渲染，分隔符作为 `meo-md-critic-marker` 保留。
- 审阅（接受/拒绝、全部接受/全部拒绝、批注列表）使用 `criticMarksInState`：跳过代码、HTML、反斜杠转义、
  行内与块级公式、链接地址和自动链接，与渲染一致。嵌套标记随外层一起处理，按钮作用于光标下最内层的标记。

尚未支持：Live/Source 中标题内的标记；同类标记嵌套（例如 `{++a {++b++} c++}`，第一个结束符生效）。
修改后运行 `bun scripts/test-criticmarkup.ts` 和 `bun scripts/test-criticmarkup-review.ts`。

