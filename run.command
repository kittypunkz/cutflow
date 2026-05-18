#!/bin/zsh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

pick_port() {
  for port in 5000 5050 8000 8080; do
    if ! lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$port"
      return 0
    fi
  done
  return 1
}

echo "Starting CutFlow..."

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3 first."
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffmpeg or ffprobe not found."
  echo "Install with: brew install ffmpeg"
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate

if ! python -c "import flask" >/dev/null 2>&1; then
  echo "Installing Python dependencies..."
  pip install -r requirements.txt
fi

PORT="$(pick_port)"
if [ -z "$PORT" ]; then
  echo "No free port found in: 5000, 5050, 8000, 8080"
  exit 1
fi

export PORT
echo "Using port $PORT"

(
  sleep 2
  open "http://localhost:$PORT"
) &

python app.py
