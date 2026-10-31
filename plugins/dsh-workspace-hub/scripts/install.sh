#!/usr/bin/env bash
# dsh-plugin-workspace-hub installer / rollback helper (macOS, DSH Desktop).
#
# It only edits the DSH profile manifest and runs the installation's own pnpm:
#   ~/.dsh/profiles/<profile>/package.json
#     dependencies["dsh-plugin-workspace-hub"] = "link:<this plugin dir>"
#     dsh.profile.bundles += "dsh-plugin-workspace-hub"
#   <runtime>/cli/bin/dsh plugin --profile <profile> install   (pnpm install)
#
# Modes:
#   ./scripts/install.sh              print the recommended GUI path and status (no writes)
#   ./scripts/install.sh --check      read-only preflight
#   ./scripts/install.sh --apply      write profile + install (DSH must be fully quit)
#   ./scripts/install.sh --rollback   restore the pre-install profile manifest
#
# The recommended path is the DSH Plugins page (it runs the Host's own
# installBundle: compatibility check + pnpm + bundle selection + HMR). This
# script is the offline/CLI fallback. It never edits ~/.dsh/storages.
set -euo pipefail

APP="${DSH_APP_PATH:-/Applications/DeepSeek Harness.app}"
APP_BIN="$APP/Contents/MacOS/DeepSeek Harness"
RUNTIME="$APP/Contents/Resources/runtime"
DSH_CLI="$RUNTIME/cli/bin/dsh"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PROFILE_PKG="$PROFILE_DIR/package.json"
BACKUP_DIR="$DSH_HOME/backups/workspace-hub-plugin"
BACKUP_PKG="$BACKUP_DIR/package.json.before"
PACKAGE_NAME="dsh-plugin-workspace-hub"

die()  { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

app_running() {
  # pgrep may be unavailable in exotic sandboxes; "unknown" is treated as running.
  if ! command -v pgrep >/dev/null 2>&1; then return 0; fi
  pgrep -f 'DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' >/dev/null 2>&1
}

require_app_quit() {
  if app_running; then
    die "DSH Desktop 正在运行。:desktop profile 由 App 独占管理，请先完全退出 DSH（⌘Q）再执行。"
  fi
}

run_app_node() {
  [ -x "$APP_BIN" ] || die "找不到 DSH 可执行文件：$APP_BIN"
  DSH_DESKTOP_NODE_EXECUTABLE="$APP_BIN" "$RUNTIME/bin/node" "$@"
}

edit_profile_manifest() {
  local mode="$1" # add | remove
  local tmp_script
  tmp_script="$(mktemp -t wshub-install).cjs"
  cat > "$tmp_script" <<'NODE'
const fs = require('node:fs')
const file = process.env.WSHUB_PROFILE_PKG
const pluginDir = process.env.WSHUB_PLUGIN_DIR
const name = process.env.WSHUB_PACKAGE_NAME
const mode = process.env.WSHUB_EDIT_MODE
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {}
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
if (mode === 'add') {
  pkg.dependencies[name] = `link:${pluginDir}`
  if (!bundles.includes(name)) bundles.push(name)
} else {
  delete pkg.dependencies[name]
  const index = bundles.indexOf(name)
  if (index >= 0) bundles.splice(index, 1)
}
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`edited ${file}: dependencies["${name}"]=${mode === 'add' ? `link:${pluginDir}` : '(removed)'}, bundles=[${bundles.join(', ')}]`)
NODE
  WSHUB_PROFILE_PKG="$PROFILE_PKG" WSHUB_PLUGIN_DIR="$PLUGIN_DIR" \
    WSHUB_PACKAGE_NAME="$PACKAGE_NAME" WSHUB_EDIT_MODE="$mode" \
    run_app_node "$tmp_script"
  rm -f "$tmp_script"
}

run_profile_install() {
  [ -x "$DSH_CLI" ] || die "找不到 DSH 自带 CLI：$DSH_CLI（请确认 DSH 桌面版已安装）"
  note "→ $DSH_CLI plugin --profile $PROFILE install"
  "$DSH_CLI" plugin --profile "$PROFILE" install
}

preflight() {
  note "插件目录：$PLUGIN_DIR"
  [ -f "$PLUGIN_DIR/package.json" ] || die "缺少 package.json"
  run_app_node -e '
    const fs = require("node:fs")
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    if (pkg.name !== "dsh-plugin-workspace-hub") throw new Error(`unexpected package name: ${pkg.name}`)
    if (!pkg.dsh?.bundle?.patch) throw new Error("package.json 未声明 dsh.bundle.patch，不能作为 bundle 安装")
    console.log(`package: ${pkg.name}@${pkg.version}`)
  ' "$PLUGIN_DIR/package.json"
  if [ -f "$PLUGIN_DIR/lib/index.js" ]; then note "构建产物：lib/index.js OK"; else die "缺少 lib/index.js —— 先在插件目录执行 npm install && npm run build"; fi
  [ -f "$PLUGIN_DIR/cordis.patch.yml" ] || die "缺少 cordis.patch.yml"
  note "profile：$PROFILE_PKG"
  if [ -f "$PROFILE_PKG" ]; then note "profile manifest OK"; else die "profile 未初始化：先打开一次 DSH 桌面版再完全退出"; fi
  if command -v pgrep >/dev/null 2>&1 && app_running; then note "DSH：运行中（--apply 需先完全退出）"; else note "DSH：未检测到运行中的桌面版"; fi
  if [ -f "$BACKUP_PKG" ]; then note "已存在安装前备份：$BACKUP_PKG"; else note "尚无安装前备份（首次 --apply 会创建）"; fi
  run_app_node -e '
    const fs = require("node:fs")
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const dep = pkg.dependencies?.["dsh-plugin-workspace-hub"]
    const bundles = pkg.dsh?.profile?.bundles ?? []
    console.log(`当前 profile 状态：dependency=${dep ?? "(none)"}, bundle-selected=${bundles.includes("dsh-plugin-workspace-hub")}`)
  ' "$PROFILE_PKG"
}

apply_install() {
  require_app_quit
  preflight >/dev/null
  mkdir -p "$BACKUP_DIR"
  cp -p "$PROFILE_PKG" "$BACKUP_PKG"
  note "已备份 profile manifest → $BACKUP_PKG"
  edit_profile_manifest add
  run_profile_install
  note ""
  note "安装完成。启动 DSH 桌面版后："
  note "  1. 侧栏 Plugins 页应出现 dsh-plugin-workspace-hub（已选中的 bundle 会随 profile 一起加载）"
  note "  2. 左侧工作区顶部应出现账本里的新项目；没有账本时先跑：node hub/wdhub.mjs scan --save"
  note "  3. 需要自定义配置时，在 $PROFILE_DIR/cordis.patch.yml 里按 id: wshub-workspace-hub 覆盖 config"
  note ""
  note "回滚：$0 --rollback"
}

rollback() {
  require_app_quit
  if [ ! -f "$PROFILE_PKG" ]; then die "profile manifest 不存在：$PROFILE_PKG"; fi
  if [ -f "$BACKUP_PKG" ]; then
    cp -p "$BACKUP_PKG" "$PROFILE_PKG"
    note "已从备份还原：$BACKUP_PKG → $PROFILE_PKG"
  else
    note "无备份，改为就地移除依赖与 bundle 选择"
    edit_profile_manifest remove
  fi
  run_profile_install
  note "回滚完成（插件包仍留在 $PLUGIN_DIR，未被删除）。"
}

case "${1:-}" in
  ""|--gui)
    note "推荐用 DSH 图形界面安装（无需退出 DSH）："
    note "  1. 在本目录执行：npm install && npm run build"
    note "  2. DSH → Plugins → Add plugin → 选 Install a third-party plugin"
    note "  3. package 栏填绝对路径：$PLUGIN_DIR"
    note "  4. Install → Enable now"
    note ""
    note "CLI 兜底：$0 --apply（需完全退出 DSH；完整预检：$0 --check）"
    ;;
  --check)  preflight ;;
  --apply)  apply_install ;;
  --rollback) rollback ;;
  -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" ;;
  *) die "未知参数：$1（可用：--check / --apply / --rollback / --gui）" ;;
esac
