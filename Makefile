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

clean:
	npm run clean
	rm -f *.vsix
