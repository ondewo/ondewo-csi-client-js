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

// `scripts/check_tag_matches_package.sh` must refuse a package whose files are not the tagged ones.
//
// npm publishes the working tree, the git tag records HEAD. The release runs the script after its local
// commit and before `npm publish`, so a file the build wrote but the release did not commit stops the
// release instead of reaching npm without being in the tag. Driven against a throw-away repository.
//   node --test tests/checkTagMatchesPackage.spec.js

'use strict';

const { test: runTestCase } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The script under test. */
const SCRIPT = path.join(__dirname, '..', 'scripts', 'check_tag_matches_package.sh');

/**
 * Run a command in a directory and fail the test on a non-zero exit.
 *
 * @param {string} cwd
 *   The working directory.
 * @param {string} command
 *   The executable.
 * @param {string[]} args
 *   Its arguments.
 */
function run(cwd, command, args) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
}

/**
 * Create a repository holding a committed api/ file and LICENSE, and an npm/ package copied from them.
 *
 * @returns {string}
 *   The repository directory.
 */
function packagedRepository() {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-matches-package-'));
	fs.mkdirSync(path.join(repo, 'api'));
	fs.writeFileSync(path.join(repo, 'api', 'client.js'), 'module.exports = 1;\n');
	fs.writeFileSync(path.join(repo, 'LICENSE'), 'Apache-2.0\n');
	run(repo, 'git', ['init', '-q', '-b', 'master']);
	run(repo, 'git', ['add', 'api', 'LICENSE']);
	run(repo, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init']);
	fs.mkdirSync(path.join(repo, 'npm', 'api'), { recursive: true });
	fs.copyFileSync(path.join(repo, 'api', 'client.js'), path.join(repo, 'npm', 'api', 'client.js'));
	fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(repo, 'npm', 'LICENSE'));
	fs.writeFileSync(path.join(repo, 'npm', 'package.json'), '{ "name": "probe", "version": "1.0.0" }\n');
	fs.writeFileSync(path.join(repo, 'npm', 'README.md'), 'derived copy, not compared\n');
	return repo;
}

/**
 * Run the script against a repository.
 *
 * @param {string} repo
 *   The repository directory.
 * @returns {{status: number|null, stdout: string}}
 *   Its exit status and output.
 */
function check(repo) {
	return spawnSync('sh', [SCRIPT, 'npm'], { cwd: repo, encoding: 'utf8' });
}

runTestCase('a package of committed, unchanged files passes', () => {
	const repo = packagedRepository();
	try {
		const result = check(repo);
		assert.equal(result.status, 0, result.stdout);
		assert.match(result.stdout, /all 2 published files are committed and equal at HEAD/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

runTestCase('a published file that differs from HEAD fails', () => {
	const repo = packagedRepository();
	try {
		fs.appendFileSync(path.join(repo, 'npm', 'api', 'client.js'), '// built after the commit\n');
		const result = check(repo);
		assert.equal(result.status, 1);
		assert.match(result.stdout, /api\/client\.js is published with content that differs from HEAD/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

runTestCase('a published file that was never committed fails', () => {
	const repo = packagedRepository();
	try {
		fs.writeFileSync(path.join(repo, 'npm', 'api', 'extra.js'), 'module.exports = 2;\n');
		const result = check(repo);
		assert.equal(result.status, 1);
		assert.match(result.stdout, /api\/extra\.js is published but not committed/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
