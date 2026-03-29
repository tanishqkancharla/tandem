#!/usr/bin/env bash
set -euo pipefail

REPO="${SLACK_CLI_REPO:-stablyai/agent-slack}"
RELEASE_BIN_NAME="agent-slack"
INSTALL_BIN_NAME="slack-cli"
SKIP_VERIFY="${SLACK_CLI_SKIP_VERIFY:-0}"
INSTALL_SOURCE="${SLACK_CLI_INSTALL_SOURCE:-main}"
MAIN_REF="${SLACK_CLI_MAIN_REF:-main}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${SLACK_CLI_INSTALL_DIR:-${ROOT}/bin}"
VENDOR_DIR="${ROOT}/vendor/agent-slack"

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }
die() { err "error: $*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

download() {
  url="$1"
  dest="$2"
  if have curl; then
    curl -fsSL "$url" -o "$dest"
    return
  fi
  if have wget; then
    wget -qO "$dest" "$url"
    return
  fi
  die "curl or wget is required"
}

hash_file() {
  file="$1"
  if have sha256sum; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  if have shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  if have openssl; then
    openssl dgst -sha256 "$file" | awk '{print $2}'
    return
  fi
  die "sha256sum, shasum, or openssl is required to verify downloads"
}

is_musl() {
  if have ldd; then
    ldd --version 2>&1 | grep -qi musl && return 0
    ldd /bin/sh 2>&1 | grep -qi musl && return 0
  fi
  ls /lib/ld-musl-*.so* >/dev/null 2>&1 && return 0
  return 1
}

detect_platform() {
  os="$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    linux | darwin) platform="$os" ;;
    msys* | mingw* | cygwin*) platform="windows" ;;
    *) die "Unsupported OS: $os" ;;
  esac

  arch="$(uname -m 2>/dev/null)"
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac

  musl_suffix=""
  if [ "$platform" = "linux" ] && is_musl; then
    musl_suffix="-musl"
  fi

  exe_suffix=""
  if [ "$platform" = "windows" ]; then
    exe_suffix=".exe"
  fi
}

install_from_main() {
  have git || die "git is required for SLACK_CLI_INSTALL_SOURCE=main"
  have bun || die "bun is required for SLACK_CLI_INSTALL_SOURCE=main"

  mkdir -p "$INSTALL_DIR"
  rm -rf "$VENDOR_DIR"

  log "Cloning $REPO#$MAIN_REF..."
  git clone --depth 1 --branch "$MAIN_REF" "https://github.com/$REPO.git" "$VENDOR_DIR"

  log "Installing dependencies with bun..."
  (
    cd "$VENDOR_DIR"
    bun install --frozen-lockfile
  )

  cat > "$INSTALL_DIR/$INSTALL_BIN_NAME" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR="${ROOT}/vendor/agent-slack"

exec bun "${VENDOR}/bin/agent-slack.bun.js" "$@"
EOF

chmod 755 "$INSTALL_DIR/$INSTALL_BIN_NAME"
log "Installed $INSTALL_BIN_NAME (source: $REPO#$MAIN_REF) to $INSTALL_DIR/$INSTALL_BIN_NAME"
}

install_from_release() {
  detect_platform

  asset="${RELEASE_BIN_NAME}-${platform}-${arch}${musl_suffix}${exe_suffix}"
  version="${SLACK_CLI_VERSION:-}"
  if [ -n "$version" ]; then
    case "$version" in
      v*) tag="$version" ;;
      *) tag="v$version" ;;
    esac
    base_url="https://github.com/$REPO/releases/download/$tag"
  else
    base_url="https://github.com/$REPO/releases/latest/download"
  fi

  tmpdir="$(mktemp -d 2>/dev/null || mktemp -d -t slack-cli.XXXXXX)"
  trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

  bin_tmp="$tmpdir/$asset"
  log "Downloading $asset..."
  download "$base_url/$asset" "$bin_tmp"

  if [ "$SKIP_VERIFY" != "1" ]; then
    log "Verifying checksum..."
    sums_tmp="$tmpdir/checksums-sha256.txt"
    download "$base_url/checksums-sha256.txt" "$sums_tmp"
    expected="$(awk -v file="$asset" '$2 == file {print $1; exit}' "$sums_tmp")"
    [ -z "$expected" ] && die "Checksum not found for $asset"
    actual="$(hash_file "$bin_tmp")"
    [ "$expected" != "$actual" ] && die "Checksum mismatch for $asset"
  fi

  mkdir -p "$INSTALL_DIR"
  cp "$bin_tmp" "$INSTALL_DIR/$INSTALL_BIN_NAME$exe_suffix"
  chmod 755 "$INSTALL_DIR/$INSTALL_BIN_NAME$exe_suffix"
  log "Installed $INSTALL_BIN_NAME to $INSTALL_DIR/$INSTALL_BIN_NAME$exe_suffix"
}

main() {
  case "$INSTALL_SOURCE" in
    main)
      install_from_main
      ;;
    release)
      install_from_release
      ;;
    *)
      die "Unsupported SLACK_CLI_INSTALL_SOURCE: $INSTALL_SOURCE (expected: main or release)"
      ;;
  esac
}

main "$@"
