#!/usr/bin/env bash
# Download (if needed) and run a local Paper server for mc-jev bots.
#
#   ./scripts/server.sh                 download if missing, then start the server
#   ./scripts/server.sh --download-only download and configure, but don't start
#
# Environment:
#   MC_VERSION  Minecraft version to run (default: 26.1.2, within Mineflayer's supported 26.1)
#   MC_MEMORY   JVM heap size (default: 2G)
#
# The server runs with online-mode=false so bots can join without Mojang accounts.
# It listens on 127.0.0.1 only. Never expose this server to the internet.
set -euo pipefail

MC_VERSION="${MC_VERSION:-26.1.2}"
MC_MEMORY="${MC_MEMORY:-2G}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/server"
API="https://fill.papermc.io/v3/projects/paper/versions/$MC_VERSION/builds/latest"

mkdir -p "$DIR"
cd "$DIR"

JAR="$(ls paper-"$MC_VERSION"-*.jar 2>/dev/null | sort -V | tail -1 || true)"

if [[ -z "$JAR" ]]; then
  echo "Looking up the latest Paper build for $MC_VERSION..."
  BUILD_JSON="$(curl -fsS "$API")"
  read -r NAME URL SHA < <(python3 -c '
import json, sys
d = json.load(sys.stdin)["downloads"]["server:default"]
print(d["name"], d["url"], d["checksums"]["sha256"])
' <<<"$BUILD_JSON")
  echo "Downloading $NAME..."
  curl -fSL --progress-bar -o "$NAME.part" "$URL"
  echo "$SHA  $NAME.part" | sha256sum -c --quiet - || { rm -f "$NAME.part"; echo "Checksum mismatch" >&2; exit 1; }
  mv "$NAME.part" "$NAME"
  JAR="$NAME"
fi

# Settings for bot experiments (only written on first run so your edits are kept).
if [[ ! -f server.properties ]]; then
  cat > server.properties <<PROPS
online-mode=false
enforce-secure-profile=false
server-ip=127.0.0.1
server-port=25565
motd=mc-jev test server
difficulty=normal
spawn-protection=0
max-players=20
PROPS
fi

if [[ "${1:-}" == "--download-only" ]]; then
  echo "Ready: $DIR/$JAR (start it later with ./scripts/server.sh)"
  exit 0
fi

# The Minecraft EULA must be accepted by you, interactively.
if ! grep -qs '^eula=true' eula.txt; then
  echo
  echo "Running a Minecraft server requires accepting the Minecraft EULA:"
  echo "  https://aka.ms/MinecraftEULA"
  read -r -p "Do you accept the EULA? Type 'yes' to continue: " ANSWER
  if [[ "$ANSWER" != "yes" ]]; then
    echo "EULA not accepted; not starting the server."
    exit 1
  fi
  echo "eula=true" > eula.txt
fi

echo "Starting $JAR (online-mode=false; keep this server off the internet)."
exec java "-Xmx$MC_MEMORY" "-Xms$MC_MEMORY" -jar "$JAR" --nogui
