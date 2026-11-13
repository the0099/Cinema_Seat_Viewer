#!/usr/bin/env bash
# Copies the shared 3D code into the extension folder (Chrome loads only files inside it).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p extension/lib/vendor
cp js/hall.js js/seatView3d.js extension/lib/
cp js/vendor/three.module.min.js js/vendor/three.LICENSE extension/lib/vendor/
echo "extension/lib updated"
