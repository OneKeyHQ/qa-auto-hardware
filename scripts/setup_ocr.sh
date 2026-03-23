#!/usr/bin/env bash
# setup_ocr.sh — Set up the Python virtualenv for QA Auto Hardware OCR
#
# Creates scripts/.venv/ with a compatible Python and installs PaddleOCR deps.
# Run from the project root: bash scripts/setup_ocr.sh
#
# After setup, Electron will automatically use scripts/.venv/bin/python
# (see electron/paddleOcrEn.ts resolvePythonBin).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"

# ── Find a compatible Python (3.9–3.12) ──────────────────────────────────────
find_python() {
  local candidates=(
    "${QA_AUTO_HW_PYTHON_BIN:-}"
    python3.12
    python3.11
    python3.10
    python3.9
    python3
  )
  for bin in "${candidates[@]}"; do
    [[ -z "$bin" ]] && continue
    if command -v "$bin" &>/dev/null; then
      local ver
      ver=$("$bin" -c "import sys; print(sys.version_info[:2])" 2>/dev/null)
      # Accept (3, 9) through (3, 12)
      if echo "$ver" | grep -qE "\(3, (9|10|11|12)\)"; then
        echo "$bin"
        return 0
      fi
    fi
  done
  return 1
}

echo "🔍  Looking for compatible Python (3.9–3.12)..."
PYTHON_BIN=$(find_python) || {
  echo ""
  echo "❌  No compatible Python found (need 3.9–3.12)."
  echo "    PaddlePaddle does not yet support Python 3.13+."
  echo ""
  echo "    Options:"
  echo "      brew install python@3.12"
  echo "      pyenv install 3.12"
  echo "      Or set QA_AUTO_HW_PYTHON_BIN=/path/to/python3.12 and re-run."
  exit 1
}

PYTHON_VER=$("$PYTHON_BIN" --version 2>&1)
echo "✅  Using $PYTHON_BIN ($PYTHON_VER)"

# ── Create or update the virtualenv ──────────────────────────────────────────
if [[ -d "$VENV_DIR" ]]; then
  echo "♻️   Reusing existing venv at $VENV_DIR"
else
  echo "📦  Creating venv at $VENV_DIR..."
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

VENV_PYTHON="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"

# ── Install dependencies ──────────────────────────────────────────────────────
echo "⬇️   Installing OCR dependencies (this may take a few minutes)..."
"$VENV_PIP" install --upgrade pip --quiet
"$VENV_PIP" install -r "$REQUIREMENTS"

# ── Smoke-test the install ────────────────────────────────────────────────────
echo "🧪  Verifying installation..."
"$VENV_PYTHON" -c "
import paddle, cv2, numpy, PIL, yaml, paddleocr
print(f'  paddle     {paddle.__version__}')
print(f'  paddleocr  {paddleocr.__version__}')
print(f'  cv2        {cv2.__version__}')
print(f'  numpy      {numpy.__version__}')
print(f'  Pillow     {PIL.__version__}')
"

echo ""
echo "✅  OCR environment ready."
echo "    Venv Python: $VENV_PYTHON"
echo ""
echo "    Electron will pick this up automatically in dev mode."
echo "    To override, set: QA_AUTO_HW_PYTHON_BIN=$VENV_PYTHON"
