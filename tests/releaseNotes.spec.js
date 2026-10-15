// Copyright 2021-2026 ONDEWO GmbH
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

// THE GITHUB RELEASE BODY IS SLICED OUT OF RELEASE.md BY THE MAKEFILE.
//
// `RELEASE_NOTES_SLICE` prints RELEASE.md from the heading `## Release ONDEWO CSI Js Client <version>`
// (anchored, version quoted) to the next `*****` line. A heading spelled any other way, or a section
// without its separator, gives an empty or overlong slice. `release_preflight` and `build_gh_release`
// refuse an empty one; this suite keeps the file in the shape the slice expects.
//
//   node --test tests/releaseNotes.spec.js

'use strict';

const { test: runTestCase } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** The repository root. */
const REPO_ROOT = path.join(__dirname, '..');

/** The Makefile that slices the release notes. */
const MAKEFILE = fs.readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8');

/** The release notes; `src/RELEASE.md` is the source the build copies over the root file. */
const RELEASE_NOTES = fs.readFileSync(path.join(REPO_ROOT, 'src', 'RELEASE.md'), 'utf8');

/**
 * The exact slice command in the Makefile, as written there: make turns `\#` into `#` and `$$` into `$`,
 * and expands `$(ONDEWO_CSI_VERSION)`.
 */
const SLICE_COMMAND =
	"RELEASE_NOTES_SLICE=perl -ne 'print if /^\\#+ Release ONDEWO CSI Js Client \\Q$(ONDEWO_CSI_VERSION)\\E$$/../^\\*{5}/'";

/** Every release heading must read exactly like this. */
const HEADING = /^## Release ONDEWO CSI Js Client (\d+\.\d+\.\d+)$/;

/**
 * Run the Makefile's perl range over RELEASE.md for one version, exactly as the release does.
 *
 * @param {string} version
 *   The version whose section is sliced.
 * @param {string} [input]
 *   The release notes to slice; RELEASE.md by default.
 * @returns {string}
 *   The slice: the heading line through the next `*****` separator.
 */
function sliceReleaseNotes(version, input = RELEASE_NOTES) {
	return execFileSync('perl', ['-ne', `print if /^#+ Release ONDEWO CSI Js Client \\Q${version}\\E$/../^\\*{5}/`], {
		input,
		encoding: 'utf8'
	});
}

runTestCase('the Makefile slices the heading spelling and separator pinned here', () => {
	assert.ok(MAKEFILE.includes(SLICE_COMMAND), `the Makefile no longer contains: ${SLICE_COMMAND}`);
});

runTestCase('RELEASE.md and src/RELEASE.md are identical', () => {
	assert.equal(fs.readFileSync(path.join(REPO_ROOT, 'RELEASE.md'), 'utf8'), RELEASE_NOTES);
});

runTestCase('every release heading uses the spelling the Makefile slices, once per version', () => {
	const headings = RELEASE_NOTES.split('\n').filter((line) => /^#+\s*Release ONDEWO\b/i.test(line));
	assert.ok(headings.length > 0);
	assert.deepEqual(
		headings.filter((line) => !HEADING.test(line)),
		[]
	);
	const versions = headings.map((line) => line.replace(HEADING, '$1'));
	assert.deepEqual(
		versions.filter((version, index) => versions.indexOf(version) !== index),
		[]
	);
});

runTestCase('every section ends at its own ***** separator, before the next heading', () => {
	const lines = RELEASE_NOTES.split('\n');
	const headingIndexes = lines.map((line, index) => index).filter((index) => HEADING.test(lines[index]));
	headingIndexes.forEach((start, position) => {
		const end = headingIndexes[position + 1] ?? lines.length;
		const section = lines.slice(start + 1, end);
		const separator = section.findIndex((line) => /^\*{5}/.test(line));
		assert.ok(separator >= 0, `${lines[start]} has no ***** separator before the next heading`);
		assert.ok(
			section.slice(0, separator).some((line) => line.trim().length > 0),
			`${lines[start]} has no content`
		);
	});
});

runTestCase('the version the Makefile releases has a non-empty slice', () => {
	const match = /^ONDEWO_CSI_VERSION=(\S+)$/m.exec(MAKEFILE);
	assert.ok(match, 'no ONDEWO_CSI_VERSION= line in the Makefile');
	const slice = sliceReleaseNotes(match[1]).trimEnd().split('\n');
	assert.ok(HEADING.test(slice[0]), `the slice does not start at the heading: ${slice[0]}`);
	assert.ok(slice.filter((line) => line.trim().length > 0).length > 2, 'the slice is empty');
	assert.ok(/^\*{5}/.test(slice[slice.length - 1]), 'the slice does not end at a ***** separator');
});

runTestCase('the slice is anchored: a version never matches a longer one, and a dot is not a wildcard', () => {
	const notes = [
		'## Release ONDEWO CSI Js Client 19.1.0',
		'',
		'- not this one',
		'',
		'*****************',
		'## Release ONDEWO CSI Js Client 9x1x0',
		'',
		'- nor this one',
		'',
		'*****************',
		''
	].join('\n');
	assert.equal(sliceReleaseNotes('9.1.0', notes), '');
});
