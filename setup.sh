#!/usr/bin/env bash
#
# AgentEyes setup.
#
# Written in bash on purpose: it has to be able to run before bun exists, since
# one of its jobs is telling you bun is missing.
#
# Every step here exists because it was a silent failure first. An unregistered
# skill, a project-scoped MCP entry, a notify config with no target — none of
# them report anything. They just quietly do nothing, which is indistinguishable
# from working. So this checks, reports, and says which parts are actually live.
#
#   ./setup.sh           install and verify
#   ./setup.sh --check   diagnose only, change nothing
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$HOME/.agenteyes"
SKILL_DIR="$HOME/.claude/skills/agent-eyes"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

green=$'\033[32m'; red=$'\033[31m'; yellow=$'\033[33m'; dim=$'\033[2m'; off=$'\033[0m'
ok()   { printf "  %s✓%s %s\n" "$green" "$off" "$1"; }
bad()  { printf "  %s✗%s %s\n" "$red" "$off" "$1"; }
warn() { printf "  %s!%s %s\n" "$yellow" "$off" "$1"; }
note() { printf "    %s%s%s\n" "$dim" "$1" "$off"; }
head_() { printf "\n%s\n" "$1"; }

FAILED=0
MANUAL=()

head_ "AgentEyes setup — $REPO"
[[ $CHECK_ONLY == 1 ]] && note "--check: nothing will be modified"

# ---------------------------------------------------------------- 1. runtimes
head_ "1. Runtimes"
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version) — the server needs this and nothing else"
else
  bad "node not found — the server will not run"
  note "https://nodejs.org, or: brew install node"
  FAILED=1
fi

if command -v bun >/dev/null 2>&1; then
  ok "bun $(bun --version) — MCP bridge, notifier and tests"
else
  warn "bun not found — captures will work, the MCP bridge and notifier will not"
  note "curl -fsSL https://bun.sh/install | bash"
fi

# ------------------------------------------------------------------- 2. dirs
head_ "2. Data directory"
if [[ $CHECK_ONLY == 0 ]]; then
  mkdir -p "$DATA/captures" "$DATA/watch" "$DATA/snapshots"
fi
if [[ -d "$DATA" ]]; then
  ok "$DATA ($(ls "$DATA/captures" 2>/dev/null | wc -l | tr -d ' ') captures on disk)"
else
  bad "$DATA missing"
  FAILED=1
fi

# --------------------------------------------------------- 3. notifier config
head_ "3. Notifier config"
CFG="$DATA/notify-config.json"
if [[ -f "$CFG" ]]; then
  TARGET=$(sed -n 's/.*"target"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CFG" | head -1)
  if [[ -n "$TARGET" ]]; then
    ok "$CFG (target: $TARGET)"
  else
    warn "$CFG exists but has no target — the notifier will drop every message"
    note "set \"target\" to a pane id from: herdr agent list"
  fi
elif [[ $CHECK_ONLY == 1 ]]; then
  bad "$CFG missing — the notifier would run with no target and silently drop everything"
else
  # The pane running setup is the right default target: it is where you are.
  DETECTED="${HERDR_PANE_ID:-}"
  sed "s|\"target\": \"\"|\"target\": \"$DETECTED\"|" \
    "$REPO/notify-config.example.json" > "$CFG"
  if [[ -n "$DETECTED" ]]; then
    ok "wrote $CFG (target: $DETECTED, detected from \$HERDR_PANE_ID)"
  else
    warn "wrote $CFG with no target — the notifier will drop messages until you set one"
    note "run \`herdr agent list\`, put a pane_id in \"target\""
  fi
fi

# -------------------------------------------------------------------- 4. skill
head_ "4. Claude Code skill"
if [[ $CHECK_ONLY == 0 ]]; then
  mkdir -p "$SKILL_DIR"
  # The skill has to name a real path, and this repo may be cloned anywhere, so
  # the installed copy is rewritten rather than symlinked. Re-run setup after a
  # pull to pick up changes.
  sed "s|~/dev/rsrc/agenteyes|$REPO|g" "$REPO/SKILL.md" > "$SKILL_DIR/SKILL.md"
fi
if [[ -f "$SKILL_DIR/SKILL.md" ]]; then
  # A symlink to the repo is correct even though its content says "~/dev/..." —
  # so resolve the tilde before comparing, or this reports a false problem.
  SKILL_PATHS=$(grep -o '[~/][^ `"]*agenteyes' "$SKILL_DIR/SKILL.md" | sed "s|^~|$HOME|" | sort -u)
  if [[ -L "$SKILL_DIR/SKILL.md" ]] && [[ "$(readlink "$SKILL_DIR/SKILL.md")" == "$REPO"* ]]; then
    ok "$SKILL_DIR/SKILL.md -> symlink into this clone (stays in sync)"
  elif grep -qF "$REPO" <<< "$SKILL_PATHS"; then
    ok "$SKILL_DIR/SKILL.md (paths point at this clone)"
    [[ $CHECK_ONLY == 0 ]] && note "installed as a copy — re-run ./setup.sh after pulling"
  else
    warn "installed skill points somewhere other than $REPO"
    note "found: $(tr '\n' ' ' <<< "$SKILL_PATHS")"
    note "re-run ./setup.sh to repoint it"
  fi
else
  bad "skill not installed — agents outside this directory will not know AgentEyes exists"
  FAILED=1
fi

# ---------------------------------------------------------------------- 5. MCP
head_ "5. MCP bridge registration"
if command -v claude >/dev/null 2>&1; then
  # Listing from inside the repo finds the project-scoped .mcp.json entry — which
  # is exactly the bug (#1). The question is whether it resolves anywhere else,
  # so ask from a directory that is not this one.
  if (cd / && claude mcp list 2>/dev/null | grep -q "agent-eyes"); then
    ok "agent-eyes registered user-scoped (resolves from any directory)"
  else
    PROJECT_ONLY=0
    claude mcp list 2>/dev/null | grep -q "agent-eyes" && PROJECT_ONLY=1
    if [[ $CHECK_ONLY == 1 ]]; then
      if [[ $PROJECT_ONLY == 1 ]]; then
        warn "agent-eyes is PROJECT-scoped only — the tools vanish outside $REPO"
      else
        bad "agent-eyes not registered — the 15 bridge tools are unavailable"
      fi
      note "claude mcp add --scope user agent-eyes -- bun run $REPO/bridge/src/index.ts"
    elif claude mcp add --scope user agent-eyes \
           -e AGENT_EYES_MODE=read -e AGENT_EYES_STALE_AFTER=30 \
           -- bun run "$REPO/bridge/src/index.ts" >/dev/null 2>&1; then
      ok "registered agent-eyes user-scoped (available in every directory)"
      [[ $PROJECT_ONLY == 1 ]] && note "the project-scoped .mcp.json entry is now redundant but harmless"
    else
      warn "could not register automatically"
      note "claude mcp add --scope user agent-eyes -- bun run $REPO/bridge/src/index.ts"
    fi
  fi
else
  warn "claude CLI not found — skipping MCP registration"
  note "other harnesses: bun run $REPO/bridge/src/index.ts (stdio MCP)"
fi

# ------------------------------------------------------------ 6. what is live
head_ "6. Live check"
if curl -fsS -m 3 -o /dev/null -w "" "http://localhost:8765/watch" 2>/dev/null; then
  CODE=$(curl -s -m 3 -o /dev/null -w "%{http_code}" http://localhost:8765/context)
  ok "server responding on :8765"
  case "$CODE" in
    200) ok "a capture is available (GET /context -> 200)" ;;
    404) note "GET /context -> 404: server up, nothing captured yet. Not an error." ;;
    *)   warn "GET /context -> $CODE" ;;
  esac
  PID=$(lsof -ti :8765 -sTCP:LISTEN 2>/dev/null | head -1)
  if [[ -n "$PID" ]] && [[ "$(ps -o ppid= -p "$PID" | tr -d ' ')" == "1" ]]; then
    warn "server pid $PID is orphaned (parent is init) — its logs go nowhere"
    note "kill $PID and restart it in a terminal you can see"
  fi
else
  warn "server not running"
  note "cd $REPO/server && node server.js"
fi

if [[ -f "$DATA/notifier.json" ]]; then
  LAST=$(sed -n 's/.*"lastTick"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DATA/notifier.json")
  ok "notifier heartbeat, last tick $LAST"
else
  note "notifier not running (optional): cd $REPO && bun run notify"
fi

# ----------------------------------------------------- 7. what only you can do
head_ "7. Steps this script cannot do"
MANUAL+=("Load the extension: chrome://extensions -> Developer mode -> Load unpacked -> $REPO/extension")
MANUAL+=("Reload it there after every git pull, or Chrome keeps running the old background.js")
MANUAL+=("Assign a key for 'capture-document' at chrome://extensions/shortcuts (Chrome allows 4 suggested; 4 are taken)")
for m in "${MANUAL[@]}"; do printf "  %s→%s %s\n" "$yellow" "$off" "$m"; done

head_ "Summary"
if [[ $FAILED == 0 ]]; then
  printf "  %sSetup is usable.%s Capture with Cmd+Shift+L once the extension is loaded.\n" "$green" "$off"
else
  printf "  %sSomething required is missing%s — see the ✗ lines above.\n" "$red" "$off"
fi
printf "  Re-check any time with: %s./setup.sh --check%s\n\n" "$dim" "$off"
exit $FAILED
