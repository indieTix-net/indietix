# build-helpers.sh -- shared build logic for Lambda function source and
# layers, used by both deploy.sh (production/dev-sandbox pushes) and
# bootstrap.sh (from-scratch environment stand-up + its SAM builds).
# Sourced, not run directly. Requires repo-config.sh already sourced
# (needs load_config) and the caller to have set STAGING to a scratch
# directory it owns.

# stage_source_files <repo> <dest-dir> -- populates <dest-dir> fresh from
# the real repo's source, per repo-config.sh's FILES list for <repo>.
# Wipes <dest-dir> first, so it's always an exact, current reflection of
# the real repo -- never a stale leftover from a previous call. This is
# the one function both deploy.sh's zip-building and bootstrap.sh's SAM
# CodeUri staging go through, so there is exactly one definition of "what
# files does this Lambda need" in the whole platform.
stage_source_files() {
  local repo="$1" dest="$2"
  load_config "$repo"

  rm -rf "$dest"
  mkdir -p "$dest"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if [ ! -f "$SRC_DIR/$f" ]; then
      echo "ERROR: $repo is missing expected file: $SRC_DIR/$f" >&2
      echo "This file is required per repo-config.sh -- check it wasn't deleted." >&2
      return 1
    fi
    mkdir -p "$dest/$(dirname "$f")"
    cp "$SRC_DIR/$f" "$dest/$f"
  done <<< "$FILES"
}

# lint_build <repo> <stage-dir> -- syntax-checks every JS/MJS file in the
# staged build, then verifies every local import/require resolves to a
# file that's actually part of this same build (this is exactly the class
# of bug that caught QRScanner's missing crypto-utils.mjs/
# data-filter-utils.mjs by hand -- now it's automatic and can't be
# skipped). Deliberately does NOT check bare-specifier imports (e.g. from
# 'sms-utils') -- those come from an attached Lambda layer, not this
# build, and resolving them here would require knowing the layer's
# contents too.
lint_build() {
  local repo="$1" stage="$2"
  local had_error=0

  while IFS= read -r -d '' f; do
    if ! node --check "$f" 2>"$STAGING/lint-err.txt"; then
      echo "SYNTAX ERROR in ${f#$stage/}:" >&2
      cat "$STAGING/lint-err.txt" >&2
      had_error=1
    fi
  done < <(find "$stage" -type f \( -name "*.js" -o -name "*.mjs" \) -print0)

  if ! node -e "
    const fs = require('fs');
    const path = require('path');
    const root = '$stage';
    const files = new Set();
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.add(path.relative(root, full));
      }
    })(root);

    let ok = true;
    for (const rel of files) {
      if (!/\.(m?js)\$/.test(rel)) continue;
      const abs = path.join(root, rel);
      const src = fs.readFileSync(abs, 'utf8');
      const re = /(?:from\s*|require\()\s*['\"](\.[^'\"]+)['\"]/g;
      let m;
      while ((m = re.exec(src))) {
        const target = m[1];
        const resolved = path.relative(root, path.resolve(path.dirname(abs), target));
        const candidates = [resolved, resolved + '.mjs', resolved + '.js'];
        if (!candidates.some(c => files.has(c))) {
          console.error('UNRESOLVED IMPORT in ' + rel + ': \'' + target + '\' -> not found in this build');
          ok = false;
        }
      }
    }
    process.exit(ok ? 0 : 1);
  "; then
    had_error=1
  fi

  if [ "$had_error" != "0" ]; then
    echo "Lint FAILED for $repo." >&2
    return 1
  fi
  return 0
}

# build_zip <repo> -- echoes the path to the built zip. Aborts (no zip
# produced) if lint_build finds a syntax error or an unresolved import.
build_zip() {
  local repo="$1"
  local stage="$STAGING/build-$repo"
  stage_source_files "$repo" "$stage"

  if ! lint_build "$repo" "$stage"; then
    echo "Build aborted for $repo -- fix the issue above and try again." >&2
    return 1
  fi

  local zip_path="$STAGING/${repo}-function.zip"
  rm -f "$zip_path"
  (cd "$stage" && zip -r -q -X "$zip_path" .)
  echo "$zip_path"
}

# build_layer_zip <repo> -- rebuilds a layer's node_modules fresh (prod
# deps only, linux/x64/glibc) from its package.json, per repo-config.sh's
# LAYER_PKG_DIR for <repo>. Echoes the path to the built zip. Build only --
# does not publish; callers decide where/how (production vs. a sandbox
# account+region) that happens.
build_layer_zip() {
  local repo="$1"
  load_config "$repo"
  if [ -z "$LAYER_NAME" ]; then
    echo "$repo has no associated layer." >&2; return 1
  fi
  if [ -z "$LAYER_PKG_DIR" ] || [ ! -f "$LAYER_PKG_DIR/package.json" ]; then
    echo "No package.json found for $repo's layer at '$LAYER_PKG_DIR' -- nothing to rebuild from." >&2
    return 1
  fi

  echo "Rebuilding layer '$LAYER_NAME' from $LAYER_PKG_DIR (prod deps only, linux/x64/glibc)..." >&2
  local clean="$STAGING/layer-clean-$repo"
  rm -rf "$clean"; mkdir -p "$clean"
  cp "$LAYER_PKG_DIR/package.json" "$clean/"
  [ -f "$LAYER_PKG_DIR/package-lock.json" ] && cp "$LAYER_PKG_DIR/package-lock.json" "$clean/"
  ( cd "$clean" && npm install --omit=dev --os=linux --cpu=x64 --libc=glibc >&2 )

  local final="$STAGING/layer-final-$repo"
  rm -rf "$final"; mkdir -p "$final/nodejs"
  mv "$clean/node_modules" "$final/nodejs/node_modules"

  # sharp pulls in prebuilt binaries for every platform npm knows about, even
  # though --os/--cpu/--libc above pins us to linux/x64/glibc. The musl and
  # wasm32 variants are dead weight we never run on Lambda -- prune them so
  # the layer doesn't balloon past the (base64-inflated) publish size limit.
  rm -rf "$final/nodejs/node_modules/@img/sharp-libvips-linuxmusl-x64" \
         "$final/nodejs/node_modules/@img/sharp-linuxmusl-x64" \
         "$final/nodejs/node_modules/@img/sharp-wasm32"

  # LAYER_INCLUDE_SELF: the layer isn't just third-party deps -- it's
  # shipping this repo's own src/ too (e.g. ticket-pdf-lib), so drop it
  # into node_modules/<package-name> alongside its deps, exactly as if it
  # had been `npm install`ed itself. The consuming Lambda then just does
  # `import {...} from '<package-name>'` and Node's normal module
  # resolution finds it via the layer's /opt/nodejs/node_modules path.
  if [ "$LAYER_INCLUDE_SELF" = "true" ]; then
    local pkg_name
    pkg_name=$(node -p "require('$LAYER_PKG_DIR/package.json').name")
    local self_dir="$final/nodejs/node_modules/$pkg_name"
    mkdir -p "$self_dir"
    cp "$LAYER_PKG_DIR/package.json" "$self_dir/"
    cp -r "$LAYER_PKG_DIR/src" "$self_dir/src"
  fi

  local layer_zip="$STAGING/${repo}-layer.zip"
  rm -f "$layer_zip"
  ( cd "$final" && zip -r -q -X "$layer_zip" nodejs >&2 )
  echo "Layer zip built: $layer_zip" >&2
  unzip -l "$layer_zip" | tail -3 >&2

  echo "$layer_zip"
}
