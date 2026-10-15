export
# ---------------- BEFORE RELEASE ----------------
# 1 - Update Version Number
# 2 - Add the release notes to src/RELEASE.md
# -------------- Release Process Steps (make ondewo_release) --------------
# 1 - spc, load the credentials from devops-accounts, delete the clone
# 2 - release_preflight: credentials, version, notes and host tools, before anything changes
# 3 - build, check_build, release_tests, pre-commit, local commit, check_tag_matches_package
# 4 - npm publish, check_npm_published
# 5 - git push, release branch, release tag, GitHub release, release_verify

########################################################
# 		Variables
########################################################

ONDEWO_CSI_VERSION=5.6.0

CSI_API_GIT_BRANCH=tags/5.6.0
# Must name the tag the committed ondewo-proto-compiler submodule points at, otherwise
# check_out_correct_submodule_versions checks the submodule BACK to the older tag.
ONDEWO_PROTO_COMPILER_GIT_BRANCH=tags/5.15.5
ONDEWO_PROTO_COMPILER_DIR=ondewo-proto-compiler
CSI_APIS_DIR=src/ondewo-csi-api
CSI_PROTOS_DIR=${CSI_APIS_DIR}/ondewo
GOOGLE_PROTOS_DIR=${CSI_APIS_DIR}/google
GITHUB_GH_TOKEN?=
NPM_AUTOMATION_TOKEN?=
IMAGE_UTILS_NAME=ondewo-csi-client-utils-js:${ONDEWO_CSI_VERSION}
IMAGE_TOOLS_NAME=ondewo-csi-client-tools-js:${ONDEWO_CSI_VERSION}
PRETTIER_WRITE?=

NPM_PACKAGE=@ondewo/ondewo-csi-client-js
NPM_REGISTRY=https://registry.npmjs.org/
# The release driver (ondewo-csi-api) passes these to every client, so they keep the shared names.
VERIFY_ATTEMPTS?=20
VERIFY_INTERVAL_S?=30
GH_REPO_SLUG=ondewo/ondewo-csi-client-js

# Prints the RELEASE.md section of this version: the heading, anchored and with the version quoted
# (\Q..\E, so a dot is not a wildcard and 5.6.0 cannot match 15.6.0 or 5.6.01), through the next *****.
RELEASE_NOTES_SLICE=perl -ne 'print if /^\#+ Release ONDEWO CSI Js Client \Q$(ONDEWO_CSI_VERSION)\E$$/../^\*{5}/'
# $(call release_notes_present,<file>): succeeds only when that section has text besides its heading and separator.
release_notes_present=$(RELEASE_NOTES_SLICE) $(1) | perl -ne 'print unless /^\#+ Release ONDEWO / or /^\*{5}/' | grep -q '[[:alnum:]]'

# $(call absent_on_origin,<--tags|--heads>,<ref>): `git ls-remote --exit-code` answers 2 for "no such ref";
# 0 means the ref exists and anything else means origin could not be asked. Both of those fail.
absent_on_origin=git ls-remote --exit-code $(1) origin "$(2)" >/dev/null; rc=$$?; \
	if [ $$rc -eq 0 ]; then echo "$(2) already exists on origin"; exit 1; fi; \
	if [ $$rc -ne 2 ]; then echo "cannot query origin for $(2) (git ls-remote exit $$rc)"; exit 1; fi

# Writes a throw-away npm userconfig holding the LITERAL text ${NPM_AUTOMATION_TOKEN}: npm substitutes the
# environment value when it reads the file, so the token is never on an argv. Used inside the containers only.
WITH_NPM_USERCONFIG=cfg="$$(mktemp)" && printf '%s\n' '//registry.npmjs.org/:_authToken=$${NPM_AUTOMATION_TOKEN}' > "$$cfg" &&

# Every step that needs no credential runs under this prefix, so the tokens never reach npm ci, a
# dependency's install script, the tests, the codegen or the pre-commit hooks. Only the preflight, the
# publish, the GitHub release and release_verify are handed a token, by name, into their own container.
WITHOUT_CREDENTIALS=env -u GITHUB_GH_TOKEN -u NPM_AUTOMATION_TOKEN

# node, npm and pre-commit run on the host when it has them, otherwise in the pinned tools image (as the
# invoking user, with no credentials). The release itself needs only docker, make, git, perl and curl.
DOCKER_AS_ME=docker run --rm --user $$(id -u):$$(id -g) -e HOME=/tmp -v "$(CURDIR)":/repo -w /repo
NODE_RUN=$(if $(shell command -v npm 2>/dev/null),,$(DOCKER_AS_ME) $(IMAGE_TOOLS_NAME))
PRE_COMMIT_RUN=$(if $(and $(shell command -v npm 2>/dev/null),$(shell command -v pre-commit 2>/dev/null)),,$(DOCKER_AS_ME) $(IMAGE_TOOLS_NAME))
NODE_PREREQ=$(if $(NODE_RUN),build_tools_docker_image)

DEVOPS_ACCOUNT_GIT=ondewo-devops-accounts
# Set by the release driver (ondewo-csi-api) to its own single clone; empty means clone one here.
DEVOPS_ACCOUNT_DIR?=
# Shell prefix for a recipe line that hands a token to a container: when a token is not already in the
# environment and DEVOPS_ACCOUNT_DIR names a clone, read both from it (into the environment, never argv),
# so release_preflight and release_verify also work standalone with only DEVOPS_ACCOUNT_DIR set.
LOAD_CREDENTIALS=if [ -n "$(DEVOPS_ACCOUNT_DIR)" ] && { [ -z "$${GITHUB_GH_TOKEN:-}" ] || [ -z "$${NPM_AUTOMATION_TOKEN:-}" ]; }; then \
		test -d "$(DEVOPS_ACCOUNT_DIR)" || { echo "DEVOPS_ACCOUNT_DIR=$(DEVOPS_ACCOUNT_DIR) is not a directory"; exit 1; }; \
		set -a; eval "$$(grep -h -E '^(GITHUB_GH_TOKEN|NPM_AUTOMATION_TOKEN)=' "$(DEVOPS_ACCOUNT_DIR)/account_github.env" "$(DEVOPS_ACCOUNT_DIR)/account_npm.env")"; set +a; \
	fi;
.DEFAULT_GOAL := help

########################################################
#       ONDEWO Standard Make Targets
########################################################

setup_developer_environment_locally: install_packages install_precommit_hooks ## Installs all needed packages and precommit hooks

install_packages: ## Install npm packages
	npm i

install_precommit_hooks: ## Install precommit hooks
	npx husky install
	uv tool install pre-commit || pipx install pre-commit || pip install --user pre-commit

run_precommit_hooks: $(if $(PRE_COMMIT_RUN),build_tools_docker_image) ## Runs all precommit hooks
	$(PRE_COMMIT_RUN) .husky/pre-commit

prettier: ## Checks formatting with Prettier - Use PRETTIER_WRITE=-w to also automatically apply corrections where needed
	$(NODE_RUN) node_modules/.bin/prettier --config .prettierrc --check --ignore-path .prettierignore $(PRETTIER_WRITE) ./

eslint: ## Checks Code Logic and Typing
	$(NODE_RUN) ./node_modules/.bin/eslint --config eslint.config.mjs .

TEST: ## Prints some important variables
	@echo "Release Notes:"
	@$(RELEASE_NOTES_SLICE) RELEASE.md
	@echo "GH Token: \t $(if $(GITHUB_GH_TOKEN),<set>,<unset>)"

help: ## Print usage info about help targets
	# (first comment after target starting with double hashes ##)
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' Makefile | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-40s\033[0m %s\n", $$1, $$2}'

makefile_chapters: ## Shows all sections of Makefile
	@echo `cat Makefile| grep "########################################################" -A 1 | grep -v "########################################################"`

check_build: ## Checks if all built proto-code is there
	@rm -rf build_check.txt
	@for proto in `find src/ondewo-csi-api/ondewo -iname "*.proto*"`; \
	do \
		cat $${proto} | grep import | grep "google/" | cut -d "\"" -f 2 | cut -d "." -f 1 >> build_check.txt; \
		echo $${proto} | cut -d "/" -f 3-5 | cut -d "." -f 1 >> build_check.txt; \
	done
	@echo "`sort build_check.txt | uniq`" > build_check.txt
	@for file in `cat build_check.txt`;\
	do \
		cat api/ondewo_csi_api.js | grep -q $${file};\
		if test $$? != 0; then  echo "No Proto-Code for $${file} in api/ondewo_csi_api.js" & exit 1;fi \
	done
	@rm -rf build_check.txt

########################################################
#       Repo Specific Make Targets
########################################################

########################################################
#		Release

# The order is pinned by tests/releaseCredentials.spec.js. Everything that can fail without a credential
# (preflight, build, tests, pre-commit, the tag-vs-package check) runs before the first irreversible
# step, the npm publish; the publish is verified before anything is pushed, so a refused or lost publish
# leaves origin untouched. git push, branch, tag and the GitHub release follow, release_verify last.
release: ## Create Github and NPM Release
	@echo "Start Release"
	$(MAKE) release_preflight
	$(WITHOUT_CREDENTIALS) $(MAKE) build
	$(WITHOUT_CREDENTIALS) $(MAKE) check_build
	$(WITHOUT_CREDENTIALS) $(MAKE) release_tests
# auth/ is the hand-written Keycloak provider and its spec, and README.md is a BUILD OUTPUT
# (`make build` runs `cp src/README.md .`). Both are top-level, so `git add src` covers
# neither: leaving them out publishes a change to npm while the git tag of that same version
# does not contain it, and destroys anything written only in the root README on the next build.
# Staged BEFORE the hooks so pre-commit checks the release content, and again after them to take
# in what eslint/prettier fixed.
	git add $(RELEASE_PATHS)
	$(WITHOUT_CREDENTIALS) $(MAKE) run_precommit_hooks
	git add $(RELEASE_PATHS)
	git status --short
# Nothing staged (the content was committed by hand) is not an error; a commit that FAILS is.
	git diff --cached --quiet || git commit --no-verify -m "Preparing for Release ${ONDEWO_CSI_VERSION}"
	$(WITHOUT_CREDENTIALS) $(MAKE) check_tag_matches_package
	$(MAKE) publish_npm_via_docker
	$(MAKE) check_npm_published
	git push
	$(MAKE) create_release_branch
	$(MAKE) create_release_tag
	$(MAKE) release_to_github_via_docker_image
	$(MAKE) release_verify
	@echo "Finished Release"

RELEASE_PATHS=api auth src scripts tests Makefile README.md RELEASE.md package.json package-lock.json .ci-package.json eslint.config.mjs ${ONDEWO_PROTO_COMPILER_DIR} ${CSI_APIS_DIR}

release_preflight: ## Read-only. Fails before anything is built, committed or pushed: host tools, version, notes, credentials
	@for tool in docker make git perl curl; do \
		command -v $$tool >/dev/null || { echo "release_preflight: the host has no $$tool"; exit 1; }; \
	done
	@test ! -e $(DEVOPS_ACCOUNT_GIT) || { echo "release_preflight: ./$(DEVOPS_ACCOUNT_GIT) exists; the release mounts this directory into containers"; exit 1; }
	@$(call release_notes_present,src/RELEASE.md) \
		|| { echo "release_preflight: src/RELEASE.md has no non-empty '## Release ONDEWO CSI Js Client $(ONDEWO_CSI_VERSION)' section"; exit 1; }
	$(MAKE) spc
	$(MAKE) build_tools_docker_image
	@versions="$$($(NODE_RUN) npm view $(NPM_PACKAGE) versions --json --registry $(NPM_REGISTRY))" \
		|| { echo "release_preflight: cannot query npm for $(NPM_PACKAGE)"; exit 1; }; \
	if printf '%s\n' "$$versions" | perl -ne 'print "$$1\n" while /"([^"]+)"/g' | grep -Fxq "$(ONDEWO_CSI_VERSION)"; then \
		echo "release_preflight: npm already has $(NPM_PACKAGE)@$(ONDEWO_CSI_VERSION)"; exit 1; \
	fi
	@$(LOAD_CREDENTIALS) docker run --rm \
		-e NPM_AUTOMATION_TOKEN \
		$(IMAGE_TOOLS_NAME) make check_npm_credentials
	@$(LOAD_CREDENTIALS) docker run --rm \
		-e GITHUB_GH_TOKEN \
		$(IMAGE_TOOLS_NAME) make check_gh_credentials
# The pushes go over SSH, not through the token: prove that the real `git push` would be accepted.
	git push --dry-run
	@echo "release_preflight: OK"

# Runs INSIDE the tools image. `npm whoami` proves the token authenticates against npmjs.org (not that
# it may publish this package: npm offers no read-only probe of that short of publishing).
check_npm_credentials: ## (tools image) Fails unless NPM_AUTOMATION_TOKEN authenticates against npmjs.org
	@test -n "$${NPM_AUTOMATION_TOKEN:-}" || { echo "NPM_AUTOMATION_TOKEN is not set"; exit 1; }
	@$(WITH_NPM_USERCONFIG) npm whoami --userconfig "$$cfg" --registry $(NPM_REGISTRY) >/dev/null \
		|| { echo "NPM_AUTOMATION_TOKEN is not accepted by $(NPM_REGISTRY)"; exit 1; }
	@echo "npm token: OK"

# Runs INSIDE the tools image. GH_TOKEN is set for the one gh call only; nothing is written to a gh config.
check_gh_credentials: ## (tools image) Fails unless GITHUB_GH_TOKEN may push to the repository
	@test -n "$${GITHUB_GH_TOKEN:-}" || { echo "GITHUB_GH_TOKEN is not set"; exit 1; }
	@test "$$(GH_TOKEN="$${GITHUB_GH_TOKEN}" gh api repos/$(GH_REPO_SLUG) --jq .permissions.push)" = true \
		|| { echo "GITHUB_GH_TOKEN cannot push to $(GH_REPO_SLUG)"; exit 1; }
	@echo "GitHub token: OK"

# The suite the `tests` workflow runs, from a clean `npm ci`, BEFORE anything is committed or published:
# the workflow only runs after the push, by which time a broken package is already on npm.
release_tests: $(NODE_PREREQ) ## Runs the CI test suite against the built tree (gates the release)
	$(NODE_RUN) npm ci --no-audit --no-fund
	$(NODE_RUN) npm test

# npm publishes the working tree while the tag records HEAD: a file the build wrote but the release
# did not commit would be on npm and missing from the tag of the same version.
check_tag_matches_package: $(NODE_PREREQ) ## Fails unless every file npm would publish from npm/ is committed and byte-equal at HEAD
	$(NODE_RUN) sh scripts/check_tag_matches_package.sh npm

# A publish that npm did not accept must fail the release before the push, the branch, the tag and the
# GitHub release. Retried: the registry can take minutes to serve a version it has accepted.
check_npm_published: $(NODE_PREREQ) ## Read-only. Fails unless npm serves the released version
	@attempt=1; while :; do \
		if test "$$($(NODE_RUN) npm view $(NPM_PACKAGE)@$(ONDEWO_CSI_VERSION) version --registry $(NPM_REGISTRY) 2>/dev/null)" = "$(ONDEWO_CSI_VERSION)"; then \
			echo "npm serves $(NPM_PACKAGE)@$(ONDEWO_CSI_VERSION)"; exit 0; \
		fi; \
		if test $$attempt -ge $(VERIFY_ATTEMPTS); then \
			echo "$(NPM_PACKAGE)@$(ONDEWO_CSI_VERSION) is not on npm after $(VERIFY_ATTEMPTS) attempts"; exit 1; \
		fi; \
		echo "npm does not serve $(NPM_PACKAGE)@$(ONDEWO_CSI_VERSION) yet (attempt $$attempt/$(VERIFY_ATTEMPTS))"; \
		attempt=$$((attempt + 1)); sleep $(VERIFY_INTERVAL_S); \
	done

release_verify: build_tools_docker_image check_npm_published ## Read-only. Fails unless origin has the tag, the GitHub release has notes and npm serves the version
	@git ls-remote --exit-code --tags origin "refs/tags/$(ONDEWO_CSI_VERSION)" >/dev/null \
		|| { echo "origin has no tag $(ONDEWO_CSI_VERSION)"; exit 1; }
	@$(LOAD_CREDENTIALS) docker run --rm \
		-e GITHUB_GH_TOKEN \
		$(IMAGE_TOOLS_NAME) make check_gh_release_notes
	@echo "release_verify: OK"

# Runs INSIDE the tools image.
check_gh_release_notes: ## (tools image) Fails unless the GitHub release of the version exists with a non-empty body
	@test -n "$$(GH_TOKEN="$${GITHUB_GH_TOKEN}" gh release view "$(ONDEWO_CSI_VERSION)" --repo $(GH_REPO_SLUG) --json body --jq .body)" \
		|| { echo "GitHub release $(ONDEWO_CSI_VERSION) is missing or has an empty body"; exit 1; }

gh_release: build_utils_docker_image release_to_github_via_docker_image ## Builds Utils Image and Releases to Github

create_release_branch: ## Create Release Branch and push it to origin
	git checkout -b "release/${ONDEWO_CSI_VERSION}"
	git push -u origin "release/${ONDEWO_CSI_VERSION}"

create_release_tag: ## Create Release Tag and push it to origin
	git tag -a ${ONDEWO_CSI_VERSION} -m "release/${ONDEWO_CSI_VERSION}"
	git push origin ${ONDEWO_CSI_VERSION}

# Runs INSIDE the release image. "$${GITHUB_GH_TOKEN}" is expanded by the shell from the environment;
# $(GITHUB_GH_TOKEN) would be expanded by make INTO the recipe line, i.e. onto the argv of `/bin/sh -c`.
# --verify-tag: never let gh create the tag itself from the default branch.
build_gh_release: ## (release image) Creates the GitHub release; refuses empty notes
	@$(call release_notes_present,RELEASE.md) \
		|| { echo "ERROR: no non-empty 'Release ONDEWO CSI Js Client $(ONDEWO_CSI_VERSION)' section in RELEASE.md"; exit 1; }
	@$(RELEASE_NOTES_SLICE) RELEASE.md > /tmp/release-notes.md
	@GH_TOKEN="$${GITHUB_GH_TOKEN}" gh release create "$(ONDEWO_CSI_VERSION)" --repo $(GH_REPO_SLUG) \
		--verify-tag --notes-file /tmp/release-notes.md --title "Release ${ONDEWO_CSI_VERSION}"

########################################################
#		Docker

build_compiler: ## Builds Ondewo-Proto-Compiler
	cd ondewo-proto-compiler/js && sh build.sh

release_to_github_via_docker_image: ## Release to Github via docker
	@docker run --rm \
		-e GITHUB_GH_TOKEN \
		${IMAGE_UTILS_NAME} make build_gh_release

build_utils_docker_image: ## Build the release image (tools + npm/ and the release notes)
	docker build --target release -f Dockerfile.utils -t ${IMAGE_UTILS_NAME} .

build_tools_docker_image: ## Build the tools image (node, npm, gh, pre-commit); needs nothing the build produces
	docker build --target tools -f Dockerfile.utils -t ${IMAGE_TOOLS_NAME} .

publish_npm_via_docker: build_utils_docker_image ## Builds the release image and publishes npm/ from it
	@docker run --rm \
		-e NPM_AUTOMATION_TOKEN \
		${IMAGE_UTILS_NAME} make docker_npm_release

# Runs INSIDE the release image.
docker_npm_release: ## (release image) Publishes npm/ to npmjs.org
	node --version
	npm --version
	@$(WITH_NPM_USERCONFIG) npm whoami --userconfig "$$cfg" --registry $(NPM_REGISTRY) \
		&& npm publish ./npm --access public --userconfig "$$cfg" --registry $(NPM_REGISTRY)

########################################################
#		DEVOPS-ACCOUNTS

# The credentials are exported into the sub-make's ENVIRONMENT (anchored `^NAME=` lines only, so a
# comment mentioning a name cannot break a value). `make release NAME=<value>` would put every value
# on make's argv, which /proc/<pid>/cmdline shows to every user on the host. A clone made here is
# deleted right after the values are read, BEFORE `$(MAKE) release` (whose containers mount this
# directory), and by the EXIT trap when anything fails. A clone named by DEVOPS_ACCOUNT_DIR belongs to
# the caller (the release driver), which deletes it. The sub-make is spelled `make`, not `$(MAKE)`: make
# runs a recipe line that mentions $(MAKE) even under `make -n`, so a dry run would clone the credentials.
ondewo_release: spc ## Release with credentials from devops-accounts repo
	@set -e; \
	if [ -n "$(DEVOPS_ACCOUNT_DIR)" ]; then \
		test -d "$(DEVOPS_ACCOUNT_DIR)" || { echo "DEVOPS_ACCOUNT_DIR=$(DEVOPS_ACCOUNT_DIR) is not a directory"; exit 1; }; \
		accounts="$(DEVOPS_ACCOUNT_DIR)"; \
	else \
		trap 'rm -rf $(DEVOPS_ACCOUNT_GIT)' EXIT; \
		rm -rf $(DEVOPS_ACCOUNT_GIT); \
		git clone -q git@bitbucket.org:ondewo/$(DEVOPS_ACCOUNT_GIT).git $(DEVOPS_ACCOUNT_GIT); \
		accounts=$(DEVOPS_ACCOUNT_GIT); \
	fi; \
	set -a; \
	eval "$$(grep -h -E '^(GITHUB_GH_TOKEN|NPM_AUTOMATION_TOKEN)=' "$$accounts/account_github.env" "$$accounts/account_npm.env")"; \
	set +a; \
	rm -rf $(DEVOPS_ACCOUNT_GIT); \
	make release

spc: ## Fails if the release branch or tag already exists, locally or on origin (anchored, exact refs)
	@if git rev-parse -q --verify "refs/tags/$(ONDEWO_CSI_VERSION)" >/dev/null; then echo "-- Test 1: tag $(ONDEWO_CSI_VERSION) exists locally"; exit 1; fi
	@if git rev-parse -q --verify "refs/heads/release/$(ONDEWO_CSI_VERSION)" >/dev/null; then echo "-- Test 2: branch release/$(ONDEWO_CSI_VERSION) exists locally"; exit 1; fi
	@$(call absent_on_origin,--tags,refs/tags/$(ONDEWO_CSI_VERSION))
	@$(call absent_on_origin,--heads,refs/heads/release/$(ONDEWO_CSI_VERSION))
	@echo "-- spc: neither tag $(ONDEWO_CSI_VERSION) nor branch release/$(ONDEWO_CSI_VERSION) exists"

########################################################
# Build

# Every component may have several digits: `[0-9]*.[0-9]*.[0-9]` could not match "9.1.10" at all.
update_package: ## Updates Package Version in src/package.json
	@perl -i -pe "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"${ONDEWO_CSI_VERSION}\"/g" src/package.json

build: check_out_correct_submodule_versions build_compiler update_package npm_run_build ## Build Code with Proto-Compiler
	cp src/package.json .
	cp src/README.md .
	cp src/RELEASE.md .
	make restore_ci_test_setup
	make create_npm_package
	make remove_npm_script
	@$(eval README_CUT_LINES:=$(shell cat -n src/README.md | perl -ne 'print if /START OF GITHUB README/../END OF GITHUB README/' | grep -o -E '[0-9]+' | perl -pe 's/^0+//' | awk 'NR==1; END{print}'))
	@$(eval DELETE_LINES:=$(shell echo ${README_CUT_LINES}| perl -pe "s/[[:space:]]/,/"))
	@perl -i -ne 'BEGIN{($$s,$$e)=split/,/,"${DELETE_LINES}"} print unless $$. >= $$s && $$. <= $$e' npm/README.md
	make install_dependencies

remove_npm_script: ## Removes the scripts section from the npm/ package.json copy (root package.json is left intact)
	@test -f npm/package.json || make create_npm_package
	$(eval script_lines:= $(shell cat npm/package.json 2>/dev/null | perl -ne 'print "$$.\n" if /\"scripts\"/../\}\,/'))
	$(eval start:= $(shell echo "$(script_lines)" | awk '{print $$1}'))
	$(eval end:= $(shell echo "$(script_lines)" | awk '{print $$NF}'))
	@if [ -n "$(start)" ] && [ -n "$(end)" ]; then perl -i -ne 'print unless $$. >= $(start) && $$. <= $(end)' npm/package.json; fi

create_npm_package: ## Create NPM Package for Release
	rm -rf npm
	mkdir npm
	cp -R api npm
	cp -R auth npm
	rm -f npm/auth/*.spec.js
	cp package.json npm
	cp LICENSE npm
	cp README.md npm

# Installs what package.json declares and nothing else. `npm i --save-dev <names>` used to rewrite every
# named range to the newest release on each build, so the root manifest drifted from src/package.json
# (and a stale src range silently downgraded eslint 10 to 9).
install_dependencies: $(NODE_PREREQ) ## Installs the npm dependencies package.json declares
	$(NODE_RUN) npm install --no-audit --no-fund

check_out_correct_submodule_versions: ## Fetches all Submodules and checksout specified branch
	@echo "START checking out correct submodule versions ..."
	git submodule update --init --recursive
	git -C ${CSI_APIS_DIR} fetch --all
	git -C ${CSI_APIS_DIR} checkout ${CSI_API_GIT_BRANCH}
	git -C ${ONDEWO_PROTO_COMPILER_DIR} fetch --all
	git -C ${ONDEWO_PROTO_COMPILER_DIR} checkout ${ONDEWO_PROTO_COMPILER_GIT_BRANCH}
	@echo "DONE checking out correct submodule versions."

# The `build` script of src/package.json, run directly so the host needs no npm for it. The compiler
# writes api/ as root; the second container hands it back to the invoking user (no sudo on the host).
npm_run_build: ## Generates api/ from the protos of src/ondewo-csi-api with the proto-compiler image
	@echo "START npm run build ..."
	docker run --rm -v "$(CURDIR)/src":/input-volume -v "$(CURDIR)/api":/output-volume ondewo-js-proto-compiler ondewo-csi-api ondewo-csi-api ondewo
	docker run --rm -v "$(CURDIR)/api":/output-volume --entrypoint chown ondewo-js-proto-compiler -R "$$(id -u):$$(id -g)" /output-volume
	@echo "DONE npm run build."

restore_ci_test_setup: $(NODE_PREREQ) ## Re-add CI test scripts + devDeps (from .ci-package.json) that `cp src/package.json .` drops (keys sorted as npm writes them)
	@$(NODE_RUN) node -e 'const fs=require("fs");if(!fs.existsSync(".ci-package.json")){console.log("no .ci-package.json, skipping");process.exit(0)}const p=JSON.parse(fs.readFileSync("package.json","utf8"));const c=JSON.parse(fs.readFileSync(".ci-package.json","utf8"));p.scripts=Object.assign({},p.scripts||{},c.scripts||{});const sorted=(o)=>Object.fromEntries(Object.entries(o).sort(([a],[b])=>a.localeCompare(b,"en")));p.dependencies=sorted(Object.assign({},p.dependencies||{},c.dependencies||{}));p.devDependencies=sorted(Object.assign({},p.devDependencies||{},c.devDependencies||{}));if(c.description)p.description=c.description;fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n");console.log("restore-ci-package: merged CI test setup; scripts=["+Object.keys(p.scripts).join(",")+"]")'
