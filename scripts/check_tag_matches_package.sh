#!/bin/sh
# Fails unless every file `npm pack` would ship from the package directory (default: npm) is
# committed and byte-equal at HEAD, i.e. in the commit the release tags.
#
# npm publishes the working tree and the git tag records HEAD, so a file the build wrote but the
# release never committed reaches npm and is missing from the tag of that same version.
# package.json (scripts stripped) and README.md (GitHub part cut) are derived copies, so they are
# listed but not compared. Run from the repository root:
#   sh scripts/check_tag_matches_package.sh npm
set -euf

package_dir="${1:-npm}"
listing="$(mktemp)"
trap 'rm -f "$listing"' EXIT

(cd "$package_dir" && npm pack --dry-run --json --ignore-scripts) >"$listing"
files="$(node -e 'for (const f of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[0].files) console.log(f.path)' "$listing")"
if [ -z "$files" ]; then
	echo "check_tag_matches_package: npm pack lists no files in $package_dir"
	exit 1
fi

status=0
checked=0
for file in $files; do
	case "$file" in
	package.json | README.md) continue ;;
	esac
	checked=$((checked + 1))
	if ! git cat-file -e "HEAD:$file" 2>/dev/null; then
		echo "check_tag_matches_package: $file is published but not committed"
		status=1
	elif ! git show "HEAD:$file" | cmp -s - "$package_dir/$file"; then
		echo "check_tag_matches_package: $file is published with content that differs from HEAD"
		status=1
	fi
done

if [ "$status" -eq 0 ]; then
	echo "check_tag_matches_package: all $checked published files are committed and equal at HEAD"
fi
exit "$status"
