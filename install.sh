#!/bin/bash
#
# DevOps Bot — install / upgrade script
#
# Install:
#   curl -fsSL https://raw.githubusercontent.com/xxxxxccc/devops-bot/main/install.sh | bash
#
# Upgrade:
#   devops-bot upgrade          (built-in subcommand)
#   — or re-run the curl above
#

set -euo pipefail

# ── Configurable ─────────────────────────────────────────────────────────────
GITHUB_REPO="${DEVOPS_BOT_REPO:-xxxxxccc/devops-bot}"
INSTALL_DIR="${DEVOPS_BOT_HOME:-$HOME/.devops-bot}"
BIN_DIR="$HOME/.local/bin"

# ── Colours & helpers ────────────────────────────────────────────────────────
RED=$'\033[0;31m'  GREEN=$'\033[0;32m'  YELLOW=$'\033[1;33m'  BLUE=$'\033[0;34m'  NC=$'\033[0m'
info()    { echo -e "${BLUE}ℹ${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1"; }
error()   { echo -e "${RED}✗${NC} $1"; }

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                   DevOps Bot Installer                       ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# =============================================================================
# 1. Check runtime (Node ≥ 18)
# =============================================================================

detect_runtime() {
  if command -v node &>/dev/null; then
    NODE_VER=$(node -v | sed 's/^v//')
    NODE_MAJOR="${NODE_VER%%.*}"
    if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
      RUNTIME="node"
      success "Node.js v$NODE_VER found"
      return 0
    fi
  fi

  if command -v bun &>/dev/null; then
    RUNTIME="bun"
    success "Bun $(bun -v) found"
    return 0
  fi

  return 1
}

detect_pkg_manager() {
  if command -v pnpm &>/dev/null; then
    PKG_MGR="pnpm"
  elif [ "$RUNTIME" = "bun" ]; then
    PKG_MGR="bun"
  else
    PKG_MGR="npm"
  fi
}

info "Checking runtime..."

if ! detect_runtime; then
  error "Node.js ≥ 18 or Bun is required"
  echo ""
  echo "  Install Node.js:  https://nodejs.org/"
  echo "  Install Bun:      curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

detect_pkg_manager
success "Package manager: $PKG_MGR"
echo ""

# =============================================================================
# 2. Download latest release (or copy from local dev checkout)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fetch_latest_version() {
  local api_url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
  if command -v curl &>/dev/null; then
    curl -fsSL "$api_url" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[^"]*"\([^"]*\)".*/\1/'
  elif command -v wget &>/dev/null; then
    wget -qO- "$api_url" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[^"]*"\([^"]*\)".*/\1/'
  else
    error "curl or wget is required"
    exit 1
  fi
}

download_release() {
  local tag="$1"
  local version="${tag#v}"
  local tarball="devops-bot-${version}.tar.gz"
  local url="https://github.com/${GITHUB_REPO}/releases/download/${tag}/${tarball}"

  info "Downloading ${tag}..."

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  if command -v curl &>/dev/null; then
    curl -fsSL -o "$tmpdir/$tarball" "$url"
  else
    wget -q -O "$tmpdir/$tarball" "$url"
  fi

  # Preserve user data across upgrades
  if [ -d "$INSTALL_DIR" ]; then
    info "Upgrading existing installation (preserving data & config)..."
    # Back up user data
    [ -d "$INSTALL_DIR/data" ]       && mv "$INSTALL_DIR/data"       "$tmpdir/data_bak"
    [ -d "$INSTALL_DIR/models" ]     && mv "$INSTALL_DIR/models"     "$tmpdir/models_bak"
    [ -f "$INSTALL_DIR/.env.local" ] && cp "$INSTALL_DIR/.env.local" "$tmpdir/env_bak"
    rm -rf "$INSTALL_DIR"
  fi

  mkdir -p "$INSTALL_DIR"
  tar xzf "$tmpdir/$tarball" --strip-components=1 -C "$INSTALL_DIR"

  # Restore user data
  [ -d "$tmpdir/data_bak" ]   && mv "$tmpdir/data_bak"   "$INSTALL_DIR/data"
  [ -d "$tmpdir/models_bak" ] && mv "$tmpdir/models_bak" "$INSTALL_DIR/models"
  [ -f "$tmpdir/env_bak" ]    && mv "$tmpdir/env_bak"    "$INSTALL_DIR/.env.local"

  trap - EXIT
  rm -rf "$tmpdir"
}

install_from_local() {
  info "Installing from local build ($SCRIPT_DIR)..."

  if [ ! -d "$SCRIPT_DIR/dist" ]; then
    error "No dist/ found — run 'pnpm build' first"
    exit 1
  fi

  mkdir -p "$INSTALL_DIR"

  # Preserve user data
  local tmpdir
  tmpdir="$(mktemp -d)"
  [ -d "$INSTALL_DIR/data" ]       && mv "$INSTALL_DIR/data"       "$tmpdir/data_bak"
  [ -d "$INSTALL_DIR/models" ]     && mv "$INSTALL_DIR/models"     "$tmpdir/models_bak"
  [ -f "$INSTALL_DIR/.env.local" ] && cp "$INSTALL_DIR/.env.local" "$tmpdir/env_bak"

  # Copy runtime artefacts only (no src, no .git)
  rm -rf "$INSTALL_DIR/dist"
  cp -r "$SCRIPT_DIR/dist"          "$INSTALL_DIR/dist"
  cp    "$SCRIPT_DIR/package.json"   "$INSTALL_DIR/package.json"
  cp    "$SCRIPT_DIR/.env.example"   "$INSTALL_DIR/.env.example"
  cp    "$SCRIPT_DIR/README.md"      "$INSTALL_DIR/README.md"
  [ -f "$SCRIPT_DIR/LICENSE" ]      && cp "$SCRIPT_DIR/LICENSE" "$INSTALL_DIR/LICENSE"
  [ -f "$SCRIPT_DIR/pnpm-lock.yaml" ] && cp "$SCRIPT_DIR/pnpm-lock.yaml" "$INSTALL_DIR/pnpm-lock.yaml"

  # Restore user data
  [ -d "$tmpdir/data_bak" ]   && mv "$tmpdir/data_bak"   "$INSTALL_DIR/data"
  [ -d "$tmpdir/models_bak" ] && mv "$tmpdir/models_bak" "$INSTALL_DIR/models"
  [ -f "$tmpdir/env_bak" ]    && mv "$tmpdir/env_bak"    "$INSTALL_DIR/.env.local"
  rm -rf "$tmpdir"
}

# Decide install source
if [ "${DEVOPS_BOT_LOCAL:-}" = "1" ] || { [ -d "$SCRIPT_DIR/dist" ] && [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; }; then
  install_from_local
else
  TAG=$(fetch_latest_version)
  if [ -z "$TAG" ]; then
    error "Could not determine latest release from GitHub"
    echo "  Check: https://github.com/${GITHUB_REPO}/releases"
    echo "  Or install from a local build: DEVOPS_BOT_LOCAL=1 ./install.sh"
    exit 1
  fi
  download_release "$TAG"
fi

# Install production dependencies
info "Installing dependencies..."
cd "$INSTALL_DIR"
case "$PKG_MGR" in
  pnpm) pnpm install --prod --frozen-lockfile --silent 2>/dev/null || pnpm install --prod --silent ;;
  bun)  bun install --production --silent ;;
  npm)  npm install --omit=dev --silent ;;
esac

success "DevOps Bot installed to $INSTALL_DIR"
echo ""

# =============================================================================
# 3. Interactive configuration (first install only)
# =============================================================================

ENV_FILE="$INSTALL_DIR/.env.local"

if [ ! -f "$ENV_FILE" ]; then
  cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
  info "Created $ENV_FILE from template"
fi

# --- AI Provider ---
configure_ai() {
  if grep -q "^AI_API_KEY=your-api-key" "$ENV_FILE" || ! grep -q "^AI_API_KEY=.\+" "$ENV_FILE"; then
    echo ""
    warn "AI API Key is required"
    echo ""
    echo "  Supported providers:"
    echo -e "    ${BLUE}1)${NC} Anthropic  — https://console.anthropic.com/"
    echo -e "    ${BLUE}2)${NC} OpenAI     — https://platform.openai.com/api-keys"
    echo -e "    ${BLUE}3)${NC} Other (OpenAI-compatible: DeepSeek, Groq, Together, etc.)"
    echo ""
    echo -ne "${YELLOW}Choose provider [1]: ${NC}"
    read -r PROVIDER_CHOICE

    case "$PROVIDER_CHOICE" in
      2) AI_PROVIDER="openai" ;;
      3) AI_PROVIDER="openai"
         echo -ne "${YELLOW}Base URL (e.g. https://api.deepseek.com/v1): ${NC}"
         read -r AI_BASE_URL
         if [ -n "$AI_BASE_URL" ]; then
           sed -i.bak "s|^# AI_BASE_URL=.*|AI_BASE_URL=$AI_BASE_URL|" "$ENV_FILE"
           sed -i.bak "s|^AI_BASE_URL=.*|AI_BASE_URL=$AI_BASE_URL|" "$ENV_FILE"
           rm -f "$ENV_FILE.bak"
         fi
         ;;
      *) AI_PROVIDER="anthropic" ;;
    esac

    sed -i.bak "s|^# AI_PROVIDER=.*|AI_PROVIDER=$AI_PROVIDER|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"

    echo -ne "${YELLOW}Enter your API Key: ${NC}"
    read -r API_KEY
    if [ -n "$API_KEY" ]; then
      sed -i.bak "s|^AI_API_KEY=.*|AI_API_KEY=$API_KEY|" "$ENV_FILE"
      rm -f "$ENV_FILE.bak"
      success "AI provider configured ($AI_PROVIDER)"
    else
      warn "Skipped — set AI_API_KEY in $ENV_FILE before starting"
    fi
  fi
}

# --- Target Project ---
configure_project() {
  if grep -q "^TARGET_PROJECT_PATH=/path/to/your/project" "$ENV_FILE" || ! grep -q "^TARGET_PROJECT_PATH=.\+" "$ENV_FILE"; then
    echo ""
    warn "Target project path is required"
    echo "  This is the codebase that AI will work on"
    echo ""
    echo -ne "${YELLOW}Enter target project path [$(pwd)]: ${NC}"
    read -r PROJECT_PATH
    PROJECT_PATH="${PROJECT_PATH:-$(pwd)}"

    sed -i.bak "s|^TARGET_PROJECT_PATH=.*|TARGET_PROJECT_PATH=$PROJECT_PATH|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
    success "Project path: $PROJECT_PATH"
  fi
}

# --- IM Platform ---
configure_im() {
  local has_feishu has_slack
  has_feishu=$(grep -c "^FEISHU_APP_ID=.\+" "$ENV_FILE" 2>/dev/null || true)
  has_slack=$(grep -c "^SLACK_BOT_TOKEN=.\+" "$ENV_FILE" 2>/dev/null || true)

  if [ "$has_feishu" -gt 0 ] || [ "$has_slack" -gt 0 ]; then
    return 0
  fi

  echo ""
  warn "IM platform configuration required"
  echo ""
  echo "  Choose your chat platform:"
  echo -e "    ${BLUE}1)${NC} Feishu (Lark)  — WebSocket, no public IP needed"
  echo -e "    ${BLUE}2)${NC} Slack          — Socket Mode, no public URL needed"
  echo ""
  echo -ne "${YELLOW}Choose platform [1]: ${NC}"
  read -r IM_CHOICE

  case "$IM_CHOICE" in
    2)
      sed -i.bak "s|^# IM_PLATFORM=.*|IM_PLATFORM=slack|" "$ENV_FILE"
      rm -f "$ENV_FILE.bak"

      echo ""
      echo -e "  ${BLUE}Setup guide:${NC}"
      echo "    1. Create app:      https://api.slack.com/apps"
      echo "    2. Enable Socket Mode"
      echo "    3. Subscribe events: message.channels, message.groups, message.im, app_mention"
      echo "    4. Add scopes:       chat:write, files:read, users:read"
      echo ""
      echo -ne "${YELLOW}Slack Bot Token (xoxb-...): ${NC}"
      read -r SLACK_BOT_TOKEN
      echo -ne "${YELLOW}Slack App Token (xapp-...): ${NC}"
      read -r SLACK_APP_TOKEN

      if [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_APP_TOKEN" ]; then
        sed -i.bak "s|^# SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN|" "$ENV_FILE"
        sed -i.bak "s|^# SLACK_APP_TOKEN=.*|SLACK_APP_TOKEN=$SLACK_APP_TOKEN|" "$ENV_FILE"
        rm -f "$ENV_FILE.bak"
        success "Slack configured"
      else
        warn "Incomplete — set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in $ENV_FILE"
      fi
      ;;
    *)
      sed -i.bak "s|^# IM_PLATFORM=.*|IM_PLATFORM=feishu|" "$ENV_FILE"
      rm -f "$ENV_FILE.bak"

      echo ""
      echo -e "  ${BLUE}Setup guide:${NC}"
      echo "    1. Create app:       https://open.feishu.cn/app"
      echo "    2. Enable event:     Events & Callbacks → Event Config → Use Long Connection"
      echo "    3. Add event:        im.message.receive_v1"
      echo "    4. Add permissions:  im:message, im:message:send_as_bot, im:resource, contact:user.base:readonly"
      echo ""
      echo -ne "${YELLOW}Feishu App ID: ${NC}"
      read -r FEISHU_APP_ID
      echo -ne "${YELLOW}Feishu App Secret: ${NC}"
      read -r FEISHU_APP_SECRET

      if [ -n "$FEISHU_APP_ID" ] && [ -n "$FEISHU_APP_SECRET" ]; then
        sed -i.bak "s|^FEISHU_APP_ID=.*|FEISHU_APP_ID=$FEISHU_APP_ID|" "$ENV_FILE"
        sed -i.bak "s|^FEISHU_APP_SECRET=.*|FEISHU_APP_SECRET=$FEISHU_APP_SECRET|" "$ENV_FILE"
        rm -f "$ENV_FILE.bak"
        success "Feishu configured"
      else
        warn "Incomplete — set FEISHU_APP_ID and FEISHU_APP_SECRET in $ENV_FILE"
      fi
      ;;
  esac
}

# --- Optional: Jira ---
configure_jira() {
  if grep -q "^JIRA_URL=.\+" "$ENV_FILE" 2>/dev/null; then
    return 0
  fi
  echo ""
  echo -ne "${YELLOW}Configure Jira integration? [y/N]: ${NC}"
  read -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "  ${BLUE}API Token:${NC} https://id.atlassian.com/manage-profile/security/api-tokens"
    echo ""
    echo -ne "${YELLOW}Jira URL (e.g. https://company.atlassian.net): ${NC}"
    read -r JIRA_URL
    echo -ne "${YELLOW}Jira Username (email): ${NC}"
    read -r JIRA_USERNAME
    echo -ne "${YELLOW}Jira API Token: ${NC}"
    read -r JIRA_API_TOKEN

    if [ -n "$JIRA_URL" ] && [ -n "$JIRA_USERNAME" ] && [ -n "$JIRA_API_TOKEN" ]; then
      sed -i.bak "s|^# JIRA_URL=.*|JIRA_URL=$JIRA_URL|" "$ENV_FILE"
      sed -i.bak "s|^# JIRA_USERNAME=.*|JIRA_USERNAME=$JIRA_USERNAME|" "$ENV_FILE"
      sed -i.bak "s|^# JIRA_API_TOKEN=.*|JIRA_API_TOKEN=$JIRA_API_TOKEN|" "$ENV_FILE"
      rm -f "$ENV_FILE.bak"
      success "Jira configured"
    else
      warn "Incomplete Jira config, skipped"
    fi
  else
    info "Jira skipped (configure later in .env.local)"
  fi
}

# --- Optional: Figma ---
configure_figma() {
  if grep -q "^FIGMA_API_KEY=.\+" "$ENV_FILE" 2>/dev/null; then
    return 0
  fi
  echo ""
  echo -ne "${YELLOW}Configure Figma integration? [y/N]: ${NC}"
  read -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "  ${BLUE}Token:${NC} Figma → Settings → Personal access tokens"
    echo ""
    echo -ne "${YELLOW}Figma API Key (figd_xxx): ${NC}"
    read -r FIGMA_API_KEY

    if [ -n "$FIGMA_API_KEY" ]; then
      sed -i.bak "s|^# FIGMA_API_KEY=.*|FIGMA_API_KEY=$FIGMA_API_KEY|" "$ENV_FILE"
      rm -f "$ENV_FILE.bak"
      success "Figma configured"
    else
      warn "Figma key empty, skipped"
    fi
  else
    info "Figma skipped (configure later in .env.local)"
  fi
}

# --- Optional: local vector search ---
configure_embedding() {
  if [ -d "$INSTALL_DIR/models" ] && ls "$INSTALL_DIR/models"/*.gguf &>/dev/null; then
    return 0
  fi
  echo ""
  echo -ne "${YELLOW}Enable local vector search? (embeddinggemma-300M, ~300MB) [y/N]: ${NC}"
  read -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    info "Installing node-llama-cpp + embedding model..."
    cd "$INSTALL_DIR"
    $PKG_MGR add node-llama-cpp 2>&1 || {
      warn "node-llama-cpp install failed — retry later with: devops-bot setup-embedding"
    }
    mkdir -p "$INSTALL_DIR/models"
    npx --yes node-llama-cpp pull --dir "$INSTALL_DIR/models" \
      "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf" 2>&1 || {
      warn "Model download failed — it will auto-download on first search"
    }
    success "Vector search enabled"
  else
    info "Vector search skipped (keyword matching only)"
    info "Enable later: devops-bot setup-embedding"
  fi
}

# Only run interactive config if essential settings are missing
IS_UPGRADE=false
if grep -q "^AI_API_KEY=.\+" "$ENV_FILE" 2>/dev/null \
   && grep -q "^TARGET_PROJECT_PATH=.\+" "$ENV_FILE" 2>/dev/null \
   && ! grep -q "^TARGET_PROJECT_PATH=/path/to/your/project" "$ENV_FILE" 2>/dev/null; then
  IS_UPGRADE=true
  success "Existing configuration detected — skipping setup wizard"
fi

if [ "$IS_UPGRADE" = false ]; then
  configure_ai
  configure_project
  configure_im
  configure_jira
  configure_figma
  configure_embedding
fi

echo ""

# =============================================================================
# 4. Create global command
# =============================================================================

info "Setting up global command..."
mkdir -p "$BIN_DIR"

RUNTIME_BIN="node"
[ "$RUNTIME" = "bun" ] && RUNTIME_BIN="bun"

cat > "$BIN_DIR/devops-bot" <<LAUNCHER
#!/bin/bash
INSTALL_DIR="\$HOME/.devops-bot"
cd "\$INSTALL_DIR"
exec ${RUNTIME_BIN} dist/index.js "\$@"
LAUNCHER

chmod +x "$BIN_DIR/devops-bot"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn "$BIN_DIR is not in your PATH"
  SHELL_RC=""
  [ -f "$HOME/.zshrc" ]  && SHELL_RC="$HOME/.zshrc"
  [ -f "$HOME/.bashrc" ] && SHELL_RC="${SHELL_RC:-$HOME/.bashrc}"

  if [ -n "$SHELL_RC" ]; then
    echo -ne "${YELLOW}Add to PATH in $SHELL_RC? [Y/n]: ${NC}"
    read -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
      echo '' >> "$SHELL_RC"
      echo '# DevOps Bot' >> "$SHELL_RC"
      echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
      success "Added to $SHELL_RC — run: source $SHELL_RC"
    fi
  else
    echo "  Add this to your shell config:"
    echo '  export PATH="$HOME/.local/bin:$PATH"'
  fi
fi

echo ""

# =============================================================================
# 5. Done
# =============================================================================

echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              Installation Complete! 🎉                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "  Start:     devops-bot start"
echo "  Upgrade:   devops-bot upgrade"
echo "  Config:    $ENV_FILE"
echo "  Help:      devops-bot --help"
echo ""
