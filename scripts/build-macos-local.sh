#!/usr/bin/env bash
set -euo pipefail

VERSION_TAG="$VERSION_TAG"
DIST_DIR="dist/bin"
IDEA_CODEX_BIN_DIR="${IDEA_CODEX_BIN_DIR:-}"
PACKAGE_JSON="package.json"
PACKAGE_JSON_BAK="$(mktemp)"

cp "$PACKAGE_JSON" "$PACKAGE_JSON_BAK"

cleanup() {
  cp "$PACKAGE_JSON_BAK" "$PACKAGE_JSON"
  rm -f "$PACKAGE_JSON_BAK"
}
trap cleanup EXIT

mkdir -p "$DIST_DIR"

# Keep CI-compatible artifact names in dist/bin.
rm -f \
  "$DIST_DIR/codex-acp-x64-darwin" \
  "$DIST_DIR/codex-acp-arm64-darwin" \
  "$DIST_DIR/codex-acp-x64-darwin.zip" \
  "$DIST_DIR/codex-acp-arm64-darwin.zip"

echo "Temporarily setting package version to: ${VERSION_TAG}"
perl -i -pe 's/"version":\s*"[^"]+"/"version": "'"${VERSION_TAG}"'"/' "$PACKAGE_JSON"

echo "Building macOS binaries..."
bun build src/index.ts --minify --sourcemap --compile --target=bun-darwin-x64-baseline --outfile dist/bin/codex-acp-x64-darwin
bun build src/index.ts --minify --sourcemap --compile --target=bun-darwin-arm64 --outfile dist/bin/codex-acp-arm64-darwin

echo "Packaging artifacts in GitHub Actions format..."

(
  cd "$DIST_DIR"
  zip -q codex-acp-x64-darwin.zip codex-acp-x64-darwin
  zip -q codex-acp-arm64-darwin.zip codex-acp-arm64-darwin
)

X64_VERSION="$("$DIST_DIR/codex-acp-x64-darwin" --version | tail -n 1)"
ARM64_VERSION="$("$DIST_DIR/codex-acp-arm64-darwin" --version | tail -n 1)"

if [[ "$X64_VERSION" != *" ${VERSION_TAG}" ]]; then
  echo "Version check failed for x64: $X64_VERSION"
  exit 1
fi

if [[ "$ARM64_VERSION" != *" ${VERSION_TAG}" ]]; then
  echo "Version check failed for arm64: $ARM64_VERSION"
  exit 1
fi

echo "Done. Artifacts:"
ls -lh \
  "$DIST_DIR/codex-acp-x64-darwin" \
  "$DIST_DIR/codex-acp-arm64-darwin" \
  "$DIST_DIR/codex-acp-x64-darwin.zip" \
  "$DIST_DIR/codex-acp-arm64-darwin.zip"

if [[ -n "$IDEA_CODEX_BIN_DIR" ]]; then
  echo "Copying local macOS binaries to IntelliJ dev Codex bin dir..."
  COPIED_ARTIFACTS=()

  for artifact in \
    "codex-acp-x64-darwin" \
    "codex-acp-arm64-darwin" \
    "codex-acp-x64-darwin.zip" \
    "codex-acp-arm64-darwin.zip"; do
    source_path="$DIST_DIR/$artifact"
    target_path="$IDEA_CODEX_BIN_DIR/$artifact"

    if [[ -e "$target_path" ]]; then
      cp -f "$source_path" "$target_path"
      COPIED_ARTIFACTS+=("$target_path")
    else
      echo "Skipping missing target: $target_path"
    fi
  done

  echo "Copied artifacts:"
  if [[ ${#COPIED_ARTIFACTS[@]} -gt 0 ]]; then
    ls -lh "${COPIED_ARTIFACTS[@]}"
  else
    echo "No existing target artifacts were updated."
  fi
else
  echo "IDEA_CODEX_BIN_DIR is not set; skipping IntelliJ artifact copy."
fi

echo "Embedded version: ${VERSION_TAG}"
