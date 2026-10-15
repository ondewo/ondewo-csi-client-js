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

// RELEASE CREDENTIALS REACH EVERY PROCESS THROUGH THE ENVIRONMENT, NEVER THROUGH ITS ARGV.
//
// `/proc/<pid>/cmdline` (and `ps`) is world-readable, so a token on the command line of docker, npm, make or
// `/bin/sh -c` is visible to every user on the release host for the life of the process. make expands `$(NAME)`
// and `${NAME}` INTO a recipe line before the shell runs it, so a recipe reads a credential as `$${NAME}`, which
// the shell expands from the exported environment.
//
//   node --test tests/releaseCredentials.spec.js

'use strict';

const { test: runTestCase } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Find the repository root: the closest ancestor directory holding the Makefile.
 *
 * @param {string} start
 *   The directory to start from.
 * @returns {string}
 *   The repository root.
 */
function findRepoRoot(start) {
	let dir = start;
	while (!fs.existsSync(path.join(dir, 'Makefile'))) {
		dir = path.dirname(dir);
	}
	return dir;
}

/** The repository root. */
const REPO_ROOT = findRepoRoot(__dirname);

/** The Makefile holding the release recipes. */
const MAKEFILE = fs.readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8');

/** The recipe lines (make hands every tab-indented line to `/bin/sh -c`). */
const RECIPE_LINES = MAKEFILE.split('\n').filter((line) => line.startsWith('\t'));

/** A variable name that holds a credential. */
const SECRET_NAME = '[A-Z0-9_]*(?:TOKEN|PASSWORD|USERNAME|SECRET|API_KEY)[A-Z0-9_]*';

/** The GitHub workflows, if any. */
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * Cut the text of one make target: from its rule line to the next blank line.
 *
 * @param {string} target
 *   The target name.
 * @returns {string}
 *   The rule line and its recipe.
 */
function recipeOf(target) {
	const start = MAKEFILE.indexOf(`\n${target}:`);
	assert.ok(start >= 0, `the Makefile has no ${target} target`);
	return MAKEFILE.slice(start + 1).split('\n\n')[0];
}

runTestCase('make never expands a credential into a recipe line', () => {
	// `$(if $(NAME),<set>,<unset>)` only renders whether NAME is set; `$$` is the shell's own expansion.
	const expanded = new RegExp(`(?<!\\$)\\$[({]${SECRET_NAME}[)}]`);
	const leaking = RECIPE_LINES.filter((line) =>
		expanded.test(line.replace(new RegExp(`\\$\\(if \\$[({]${SECRET_NAME}[)}],`, 'g'), ''))
	);
	assert.deepEqual(leaking, []);
});

runTestCase('docker run forwards the credentials by name only', () => {
	assert.equal(new RegExp(`(?:-e|--env)[\\s=]+${SECRET_NAME}=`).exec(MAKEFILE), null);
	assert.match(recipeOf('release_to_github_via_docker_image'), /-e GITHUB_GH_TOKEN \\/);
	assert.match(recipeOf('publish_npm_via_docker'), /-e NPM_AUTOMATION_TOKEN \\/);
});

runTestCase('npm reads its token from the environment through a throw-away userconfig, never from its argv', () => {
	assert.equal((MAKEFILE.match(/_authToken/g) ?? []).length, 1);
	assert.ok(
		MAKEFILE.includes("printf '%s\\n' '//registry.npmjs.org/:_authToken=$${NPM_AUTOMATION_TOKEN}' > \"$$cfg\"")
	);
	assert.ok(recipeOf('docker_npm_release').includes('npm publish ./npm --access public --userconfig "$$cfg"'));
});

runTestCase('the devops release hands the credentials to the sub-make through its environment', () => {
	const recipe = recipeOf('ondewo_release');
	assert.ok(!recipe.includes('$(info)'));
	assert.ok(!recipe.includes('$(shell'));
	assert.ok(recipe.includes('set -a'));
	assert.ok(recipe.includes("grep -h -E '^(GITHUB_GH_TOKEN|NPM_AUTOMATION_TOKEN)='"));
	// `make`, not `$(MAKE)`: a line naming $(MAKE) runs even under `make -n`, which would clone the credentials.
	assert.match(recipe, /\tmake release$/);
	assert.doesNotMatch(recipe, /\$\(MAKE\)/);
	assert.equal(/\bmake\b[^\n]*\$\(info\)/.exec(MAKEFILE), null);
	assert.equal(new RegExp(`(?:\\bmake|\\$\\(MAKE\\))[^\\n]*\\b${SECRET_NAME}=`).exec(RECIPE_LINES.join('\n')), null);
});

runTestCase('ondewo_release deletes its devops-accounts clone before the release runs, and on failure', () => {
	const recipe = recipeOf('ondewo_release');
	const trap = recipe.indexOf("trap 'rm -rf $(DEVOPS_ACCOUNT_GIT)' EXIT");
	const clone = recipe.indexOf('git clone');
	const load = recipe.indexOf('eval "$$(grep');
	const remove = recipe.indexOf('rm -rf $(DEVOPS_ACCOUNT_GIT); \\', load);
	const release = recipe.indexOf('make release');
	assert.ok(trap >= 0 && trap < clone, 'the EXIT trap must be armed before the clone exists');
	assert.ok(
		load > clone && remove > load && remove < release,
		'the clone must be deleted after loading, before `make release`'
	);
	assert.ok(recipe.includes('set -e;'), 'a failed clone or load must stop the recipe (and fire the trap)');
});

runTestCase("ondewo_release uses the driver's clone named by DEVOPS_ACCOUNT_DIR instead of cloning", () => {
	assert.match(MAKEFILE, /^DEVOPS_ACCOUNT_DIR\?=$/m);
	const recipe = recipeOf('ondewo_release');
	const branch = recipe.indexOf('if [ -n "$(DEVOPS_ACCOUNT_DIR)" ]');
	assert.ok(branch >= 0 && branch < recipe.indexOf('git clone'));
	assert.ok(recipe.includes('test -d "$(DEVOPS_ACCOUNT_DIR)"'));
});

/**
 * The recipe lines of one target, in order, without their leading tab (comment lines dropped).
 *
 * @param {string} target
 *   The target name.
 * @returns {string[]}
 *   The recipe lines.
 */
function recipeLines(target) {
	return recipeOf(target)
		.split('\n')
		.slice(1)
		.filter((line) => line.startsWith('\t'))
		.map((line) => line.slice(1));
}

/** The release steps, in the order the release contract requires them. */
const RELEASE_ORDER = [
	['preflight', /^\$\(MAKE\) release_preflight$/],
	['build', /\$\(MAKE\) build$/],
	['check_build', /\$\(MAKE\) check_build$/],
	['tests', /\$\(MAKE\) release_tests$/],
	['pre-commit', /\$\(MAKE\) run_precommit_hooks$/],
	['local commit', /^git diff --cached --quiet \|\| git commit --no-verify -m /],
	['tag matches package', /\$\(MAKE\) check_tag_matches_package$/],
	['npm publish', /^\$\(MAKE\) publish_npm_via_docker$/],
	['npm serves it', /^\$\(MAKE\) check_npm_published$/],
	['git push', /^git push$/],
	['release branch', /^\$\(MAKE\) create_release_branch$/],
	['release tag', /^\$\(MAKE\) create_release_tag$/],
	['GitHub release', /^\$\(MAKE\) release_to_github_via_docker_image$/],
	['release_verify', /^\$\(MAKE\) release_verify$/]
];

runTestCase('the release runs its steps in the contract order, each exactly once', () => {
	const lines = recipeLines('release');
	const positions = RELEASE_ORDER.map(([name, pattern]) => {
		const matching = [];
		lines.forEach((line, index) => {
			if (pattern.test(line)) {
				matching.push(index);
			}
		});
		assert.equal(matching.length, 1, `the release recipe must run "${name}" exactly once`);
		return matching[0];
	});
	positions.forEach((position, index) => {
		if (index > 0) {
			assert.ok(
				position > positions[index - 1],
				`"${RELEASE_ORDER[index][0]}" must come after "${RELEASE_ORDER[index - 1][0]}"`
			);
		}
	});
});

runTestCase('no release step swallows its own failure', () => {
	const ignored = recipeLines('release').filter((line) => line.startsWith('-') || /\|\|\s*true\b/.test(line));
	assert.deepEqual(ignored, []);
});

runTestCase('the steps that need no credential run with both tokens removed from their environment', () => {
	assert.match(MAKEFILE, /^WITHOUT_CREDENTIALS=env -u GITHUB_GH_TOKEN -u NPM_AUTOMATION_TOKEN$/m);
	const lines = recipeLines('release');
	for (const step of ['build', 'check_build', 'release_tests', 'run_precommit_hooks', 'check_tag_matches_package']) {
		assert.ok(
			lines.includes(`$(WITHOUT_CREDENTIALS) $(MAKE) ${step}`),
			`${step} must run under $(WITHOUT_CREDENTIALS)`
		);
	}
});

runTestCase('release_tests installs from the lockfile before it runs the suite', () => {
	assert.deepEqual(recipeLines('release_tests'), ['$(NODE_RUN) npm ci --no-audit --no-fund', '$(NODE_RUN) npm test']);
});

runTestCase('release_preflight checks credentials, version, notes and host tools without changing anything', () => {
	const recipe = recipeOf('release_preflight');
	for (const tool of ['docker', 'make', 'git', 'perl', 'curl']) {
		assert.match(recipe, new RegExp(`for tool in [^;]*\\b${tool}\\b`));
	}
	assert.ok(recipe.includes('$(call release_notes_present,src/RELEASE.md)'));
	assert.ok(recipe.includes('$(MAKE) spc'));
	assert.ok(recipe.includes('grep -Fxq "$(ONDEWO_CSI_VERSION)"'), 'the version must be refused when npm has it');
	assert.ok(recipe.includes('make check_npm_credentials'));
	assert.ok(recipe.includes('make check_gh_credentials'));
	assert.ok(recipe.includes('git push --dry-run'));
	assert.doesNotMatch(recipe, /\bgit (?:commit|tag|checkout)\b|npm publish|gh release create|^\tgit push$/m);
	assert.ok(recipeOf('check_npm_credentials').includes('npm whoami --userconfig "$$cfg"'));
	assert.ok(recipeOf('check_gh_credentials').includes('gh api repos/$(GH_REPO_SLUG) --jq .permissions.push)" = true'));
});

runTestCase('spc and release_verify ask for exact refs, never a substring', () => {
	const spc = recipeOf('spc');
	assert.doesNotMatch(spc, /\bgrep\b/);
	assert.ok(spc.includes('git rev-parse -q --verify "refs/tags/$(ONDEWO_CSI_VERSION)"'));
	assert.ok(spc.includes('$(call absent_on_origin,--tags,refs/tags/$(ONDEWO_CSI_VERSION))'));
	assert.ok(spc.includes('$(call absent_on_origin,--heads,refs/heads/release/$(ONDEWO_CSI_VERSION))'));
	assert.ok(
		recipeOf('release_verify').includes('git ls-remote --exit-code --tags origin "refs/tags/$(ONDEWO_CSI_VERSION)"')
	);
	assert.ok(recipeOf('release_verify').includes('make check_gh_release_notes'));
});

runTestCase('the GitHub release refuses empty notes and never creates the tag itself', () => {
	const recipe = recipeOf('build_gh_release');
	assert.ok(recipe.indexOf('$(call release_notes_present,RELEASE.md)') < recipe.indexOf('gh release create'));
	assert.ok(recipe.includes('--verify-tag --notes-file'));
});

runTestCase('the release images bake in no credential and the build context excludes the devops clone', () => {
	const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile.utils'), 'utf8');
	assert.equal(new RegExp(`^\\s*(?:ENV|ARG)\\s+${SECRET_NAME}`, 'm').exec(dockerfile), null);
	const stages = [...dockerfile.matchAll(/^FROM\s.*\sAS\s+(\S+)\s*$/gm)].map((match) => match[1]);
	const unpinned = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)]
		.map((match) => match[1])
		.filter((image) => !stages.includes(image) && !/@sha256:[0-9a-f]{64}$/.test(image));
	assert.deepEqual(unpinned, [], 'every base image is pinned by digest');
	const ignored = fs.readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8').split('\n');
	for (const entry of ['ondewo-devops-accounts', 'node_modules', '.git']) {
		assert.ok(ignored.includes(entry), `.dockerignore must exclude ${entry}`);
	}
});

runTestCase('update_package bumps a version whose components have several digits', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-package-'));
	try {
		fs.mkdirSync(path.join(dir, 'src'));
		fs.writeFileSync(path.join(dir, 'src', 'package.json'), '{\n  "version": "9.1.10"\n}\n');
		execFileSync(
			'make',
			['-s', '-f', path.join(REPO_ROOT, 'Makefile'), 'update_package', 'ONDEWO_CSI_VERSION=10.20.30'],
			{
				cwd: dir,
				env: { ...process.env, MAKEFLAGS: '' }
			}
		);
		assert.equal(fs.readFileSync(path.join(dir, 'src', 'package.json'), 'utf8'), '{\n  "version": "10.20.30"\n}\n');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

runTestCase('both manifests carry the version the Makefile releases', () => {
	const version = /^ONDEWO_CSI_VERSION=(\S+)$/m.exec(MAKEFILE)[1];
	for (const manifest of ['package.json', path.join('src', 'package.json')]) {
		assert.equal(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, manifest), 'utf8')).version, version, manifest);
	}
});

runTestCase('no workflow interpolates a secret into a run line', () => {
	let files = [];
	if (fs.existsSync(WORKFLOWS_DIR)) {
		files = fs.readdirSync(WORKFLOWS_DIR);
	}
	const leaking = files.flatMap((file) =>
		fs
			.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8')
			.split('\n')
			.filter((line) => line.includes('secrets.'))
			.filter((line) => !/^\s*[\w-]+:\s*\$\{\{\s*secrets\.\w+\s*\}\}\s*$/.test(line))
			.map((line) => `${file}: ${line.trim()}`)
	);
	assert.deepEqual(leaking, []);
});

runTestCase(
	'the build keeps the root dependencies: src/package.json plus .ci-package.json declare exactly them',
	() => {
		// `make build` runs `cp src/package.json .` and merges .ci-package.json back in, then `npm i --save-dev`
		// within those ranges: a stale range in src/package.json silently downgrades the release (eslint 10 -> 9).
		const read = (file) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
		const [root, source, ci] = [read('package.json'), read(path.join('src', 'package.json')), read('.ci-package.json')];
		assert.deepEqual(source.dependencies, root.dependencies);
		assert.deepEqual({ ...source.devDependencies, ...ci.devDependencies }, root.devDependencies);
	}
);

runTestCase(
	'release_preflight and release_verify load their tokens from DEVOPS_ACCOUNT_DIR when called standalone',
	() => {
		assert.match(MAKEFILE, /^LOAD_CREDENTIALS=if \[ -n "\$\(DEVOPS_ACCOUNT_DIR\)" \]/m);
		for (const [target, count] of [
			['release_preflight', 2],
			['release_verify', 1]
		]) {
			const lines = recipeLines(target).filter((line) => line.includes('docker run'));
			assert.equal(lines.length, count, target);
			for (const line of lines) {
				assert.ok(line.startsWith('@$(LOAD_CREDENTIALS) docker run'), `${target}: ${line}`);
			}
		}
	}
);

runTestCase("npm polling honours the driver's VERIFY_ATTEMPTS and VERIFY_INTERVAL_S", () => {
	assert.match(MAKEFILE, /^VERIFY_ATTEMPTS\?=\d+$/m);
	assert.match(MAKEFILE, /^VERIFY_INTERVAL_S\?=\d+$/m);
	const recipe = recipeOf('check_npm_published');
	assert.ok(recipe.includes('-ge $(VERIFY_ATTEMPTS)'));
	assert.ok(recipe.includes('sleep $(VERIFY_INTERVAL_S)'));
	assert.ok(recipeOf('release_verify').startsWith('release_verify: build_tools_docker_image check_npm_published'));
	const output = execFileSync(
		'make',
		['-s', '-n', 'check_npm_published', 'VERIFY_ATTEMPTS=3', 'VERIFY_INTERVAL_S=10', 'NODE_RUN='],
		{ cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, MAKEFLAGS: '' } }
	);
	assert.match(output, /-ge 3;/);
	assert.match(output, /sleep 10;/);
});
