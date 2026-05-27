#!/bin/bash
# 如果提示 "operation not permitted"，请在终端运行：
#   bash ~/Downloads/安装PixVerse.sh
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

trap '
echo ""
echo "❌  出现错误，请截图发给开发者"
exit 1
' ERR

refresh_brew_path() {
    if command -v brew &>/dev/null; then
        return 0
    fi

    if [ "$(uname -m)" = "arm64" ] && [ -x "/opt/homebrew/bin/brew" ]; then
        eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)" || export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
    elif [ -x "/usr/local/bin/brew" ]; then
        eval "$(/usr/local/bin/brew shellenv 2>/dev/null)" || export PATH="/usr/local/bin:/usr/local/sbin:$PATH"
    elif [ -x "/opt/homebrew/bin/brew" ]; then
        eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null)" || export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
    fi
}

homebrew_repo_path() {
    local repo
    repo="$(brew --repo 2>/dev/null || true)"
    if [ -n "$repo" ] && [ -d "$repo/.git" ]; then
        echo "$repo"
    elif [ -d "/opt/homebrew/.git" ]; then
        echo "/opt/homebrew"
    elif [ -d "/usr/local/Homebrew/.git" ]; then
        echo "/usr/local/Homebrew"
    else
        echo ""
    fi
}

repair_homebrew_with_git() {
    local repo branch
    repo="$(homebrew_repo_path)"
    if [ -z "$repo" ]; then
        echo "           ❌ 无法定位 Homebrew 目录"
        return 1
    fi
    if ! command -v git &>/dev/null; then
        echo "           ❌ 需要 git 来修复旧版 Homebrew"
        return 1
    fi

    echo "           ─ 修复旧版 Homebrew：$repo"
    if ! git -C "$repo" fetch --force origin; then
        return 1
    fi

    branch="$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
    if [ -z "$branch" ]; then
        if git -C "$repo" rev-parse --verify origin/main >/dev/null 2>&1; then
            branch="main"
        else
            branch="master"
        fi
    fi

    if ! git -C "$repo" checkout "$branch"; then
        return 1
    fi
    if ! git -C "$repo" merge --ff-only "origin/$branch"; then
        return 1
    fi
}

brew_is_usable() {
    HOMEBREW_NO_AUTO_UPDATE=1 brew config >/dev/null 2>&1
}

update_homebrew() {
    refresh_brew_path
    echo "           ─ 更新 Homebrew ..."
    if brew update --auto-update && brew_is_usable; then
        echo "           ✓ Homebrew 更新完成"
        return 0
    fi

    echo "           ⚠️  Homebrew 仍无法识别当前 macOS，尝试先更新 Homebrew 自身 ..."
    repair_homebrew_with_git
    refresh_brew_path
    brew update --auto-update
    if ! brew_is_usable; then
        echo "           ❌ Homebrew 更新后仍无法识别当前 macOS"
        return 1
    fi
    echo "           ✓ Homebrew 更新完成"
}

clear
echo "┌─────────────────────────────────────┐"
echo "│   Atlas · PixVerse 环境自动配置     │"
echo "└─────────────────────────────────────┘"
echo ""

# ── 1/4 npm ──────────────────────────────
echo "[ 1 / 4 ]  检测 npm ..."
if command -v npm &>/dev/null; then
    echo "           ✓ npm $(npm --version) 已存在，跳过"
else
    echo "           未检测到 npm，开始安装 Node.js"
    if ! command -v brew &>/dev/null; then
        echo "           ─ 安装 Homebrew（约 5-10 分钟）"
        echo "           ⚠️  系统可能会弹出密码框，请输入 Mac 登录密码"
        echo ""
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        refresh_brew_path
        echo "           ✓ Homebrew 安装完成"
    fi
    update_homebrew
    echo "           ─ 安装 Node.js ..."
    HOMEBREW_NO_AUTO_UPDATE=1 brew install node
    export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
    echo "           ✓ Node.js $(node --version) 安装完成"
fi
echo ""

# ── 2/4 ffmpeg ───────────────────────────
echo "[ 2 / 4 ]  检测 ffmpeg ..."
if command -v ffmpeg &>/dev/null; then
    echo "           ✓ ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}') 已存在，跳过"
else
    echo "           未检测到 ffmpeg，开始安装"
    if ! command -v brew &>/dev/null; then
        echo "           ─ 安装 Homebrew（约 5-10 分钟）"
        echo "           ⚠️  系统可能会弹出密码框，请输入 Mac 登录密码"
        echo ""
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        refresh_brew_path
        echo "           ✓ Homebrew 安装完成"
    fi
    update_homebrew
    echo "           ─ 安装 ffmpeg（约 3-8 分钟）..."
    HOMEBREW_NO_AUTO_UPDATE=1 brew install ffmpeg
    export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
    echo "           ✓ ffmpeg 安装完成"
fi
echo ""

# ── 3/4 pixverse ─────────────────────────
echo "[ 3 / 4 ]  检测 PixVerse CLI ..."
if command -v pixverse &>/dev/null; then
    echo "           ✓ PixVerse CLI $(pixverse --version 2>/dev/null) 已存在，跳过安装"
else
    echo "           ─ 安装 PixVerse CLI ..."
    npm install -g pixverse
    export PATH="$(npm root -g 2>/dev/null)/../.bin:$PATH"
    echo "           ✓ PixVerse CLI 安装完成"
fi
echo ""

# ── 4/4 auth ─────────────────────────────
echo "[ 4 / 4 ]  PixVerse 账号登录 ..."
echo "           浏览器即将打开，请完成登录"
echo ""
pixverse auth login

echo ""
echo "┌─────────────────────────────────────┐"
echo "│   ✓  全部完成！现在可以打开 Atlas  │"
echo "└─────────────────────────────────────┘"
echo ""
