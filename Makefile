.PHONY: all install build test test-unit test-e2e test-vscode package clean

all: build test-unit

install:
	npm ci --no-audit --no-fund

build: install
	npm run build

test: install
	npm test

test-unit: install
	npm run test:unit

test-e2e: install
	npm run test:e2e

# Requires a display server (Xvfb) and PYDANTIC_AI_GATEWAY env var.
# On Linux: xvfb-run -a make test-vscode
test-vscode: build
	npm run test:vscode

package: build
	npm run package

bump-patch:
	npm version patch --no-git-tag-version
	git add package.json
	git commit -m "chore: bump version to $$(npm pkg get version | tr -d '\"')"

bump-minor:
	npm version minor --no-git-tag-version
	git add package.json
	git commit -m "chore: bump version to $$(npm pkg get version | tr -d '\"')"

bump-major:
	npm version major --no-git-tag-version
	git add package.json
	git commit -m "chore: bump version to $$(npm pkg get version | tr -d '\"')"

install-ext: package
	"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension $$(ls -t *.vsix | head -1) --force

