# 网课连播助手

Chrome Manifest V3 扩展，面向山东干部网络学院页面提供连续播放辅助、学时显示和人工处理提醒。
出现答题或确认弹窗时提醒使用者处理。与课程平台无隶属关系，不保证符合其现行使用规则。

## 下载与安装

在 [Releases](https://github.com/lfscqk67/wangke-extension-public/releases) 下载 `wangke-extension-2.6.0-chrome.zip`，完整解压。
Chrome 打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，选中含 `manifest.json` 的 `wangke-ext` 文件夹。
打开目标网站，点击工具栏扩展图标查看设置。保留解压目录；不要同时加载多个副本。
这不是 Chrome 应用商店签名发布包，未提供 CRX。更新前导出或记录自己的设置。

## 权限与限制

网站访问范围限 `gbwlxy.dtdjzx.gov.cn`；权限为 storage、notifications、tabs、alarms、power，分别用于设置与状态、提醒、页面管理、定时和播放期间防休眠。
扩展在该域名的匹配页面及子框架运行，可以读取和操作页面；仅在理解权限且平台允许时使用。
本人应实际参与学习、处理验证及考核；网站规则和页面改变可能影响功能。

## 开发与验证

Node.js 22 或更高版本，无需 npm 依赖：

```sh
node tools/verify.js
```

通过 3 个 JavaScript 文件语法、Manifest JSON 及 4 处资源引用检查；尚未在真实网站上做本次功能回归。

## 项目协作

本公开仓库发布经过清理的源码快照，不包含个人使用记录、机器配置或旧开发历史。
版本 2.6.0；下载前可用同一 Release 的 `SHA256SUMS.txt` 校验文件。
Windows 示例：`Get-FileHash ./下载文件.zip -Algorithm SHA256`。
源码从 `AI_START_HERE.md` 开始阅读。问题反馈见 [贡献说明](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。
发布变更见 [CHANGELOG.md](CHANGELOG.md)，第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

本项目自有代码采用 [MIT](LICENSE)。第三方运行时、依赖和平台内容适用其各自许可及使用条件。
