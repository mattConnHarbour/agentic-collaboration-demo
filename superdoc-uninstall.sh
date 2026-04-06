#!/bin/bash
set -e

# SuperDoc Uninstall Script
# Usage: curl -fsSL https://raw.githubusercontent.com/mattConnHarbour/agentic-collaboration-demo/claude-desktop/superdoc-uninstall.sh | bash

SUPERDOC_HOME="$HOME/superdoc/claude"
SKILLS_DIR="$HOME/.claude/skills"
PID_FILE="$SUPERDOC_HOME/preview.pid"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[superdoc]${NC} $1"; }
warn() { echo -e "${YELLOW}[superdoc]${NC} $1"; }
error() { echo -e "${RED}[superdoc]${NC} $1"; }

# Kill running preview server
kill_preview() {
  if [ -f "$PID_FILE" ]; then
    local pid=$(cat "$PID_FILE" 2>/dev/null | grep -o '"pid":[0-9]*' | cut -d: -f2)
    if [ -n "$pid" ]; then
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        info "Stopped preview server (PID $pid)"
      fi
    fi
  fi
}

# Kill MCP daemon
kill_mcp_daemon() {
  local mcp_pid_file="/tmp/superdoc-mcp.sock.pid"
  if [ -f "$mcp_pid_file" ]; then
    local pid=$(cat "$mcp_pid_file" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      info "Stopped MCP daemon (PID $pid)"
    fi
  fi
  rm -f /tmp/superdoc-mcp.sock /tmp/superdoc-mcp.sock.pid 2>/dev/null || true
}

# Remove superdoc directory
remove_superdoc_home() {
  if [ -d "$SUPERDOC_HOME" ]; then
    rm -rf "$SUPERDOC_HOME"
    info "Removed $SUPERDOC_HOME"
  else
    info "$SUPERDOC_HOME not found (already removed)"
  fi
}

# Remove skill (both old and new locations)
remove_skill() {
  if [ -d "$SKILLS_DIR/superdoc" ]; then
    rm -rf "$SKILLS_DIR/superdoc"
    info "Removed skill from $SKILLS_DIR/superdoc"
  fi
  if [ -d "$SKILLS_DIR/superdoc-edit-docx" ]; then
    rm -rf "$SKILLS_DIR/superdoc-edit-docx"
    info "Removed old skill from $SKILLS_DIR/superdoc-edit-docx"
  fi
}

# Remove from Claude Desktop MCP config
remove_mcp_config() {
  local claude_config="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

  if [ ! -f "$claude_config" ]; then
    return
  fi

  if ! grep -q '"superdoc"' "$claude_config"; then
    info "SuperDoc not found in Claude Desktop config"
    return
  fi

  if command -v jq &> /dev/null; then
    local tmp_config=$(mktemp)
    jq 'del(.mcpServers.superdoc)' "$claude_config" > "$tmp_config"
    mv "$tmp_config" "$claude_config"
    info "Removed SuperDoc from Claude Desktop MCP config"
  else
    warn "Install jq to auto-remove MCP config, or manually edit:"
    warn "  $claude_config"
    warn "  Remove the 'superdoc' entry from mcpServers"
  fi
}

# Print success
print_success() {
  echo ""
  echo -e "${GREEN}========================================${NC}"
  echo -e "${GREEN}  SuperDoc uninstalled successfully!${NC}"
  echo -e "${GREEN}========================================${NC}"
  echo ""
  echo "Restart Claude Desktop to complete removal."
  echo ""
}

# Main
main() {
  echo ""
  info "Uninstalling SuperDoc..."
  echo ""

  kill_preview
  kill_mcp_daemon
  remove_superdoc_home
  remove_skill
  remove_mcp_config
  print_success
}

main "$@"
