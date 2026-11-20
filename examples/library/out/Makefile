IMAGE ?= library-service
TAG ?= latest
PORT ?= 8080
NPM ?= npm
NODE ?= node

.DEFAULT_GOAL := help
.PHONY: help install build test run docker clean

help:
	@echo "make install   install development dependencies (TypeScript, node types)"
	@echo "make build     compile the service to dist/"
	@echo "make test      compile and run the test suite with node:test"
	@echo "make run       start the service on PORT=$(PORT) (default 8080)"
	@echo "make docker    build the container image $(IMAGE):$(TAG)"
	@echo "make clean     remove build output and node_modules"

install:
	$(NPM) install --no-audit --no-fund

node_modules: package.json
	$(NPM) install --no-audit --no-fund
	@touch node_modules

build: node_modules
	$(NPM) run build

test: node_modules
	$(NPM) test

run: build
	PORT=$(PORT) $(NODE) dist/src/index.js

docker:
	docker build -t $(IMAGE):$(TAG) .

clean:
	rm -rf dist node_modules
