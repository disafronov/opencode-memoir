.PHONY: help install lint lint-fix format typecheck test coverage build clean all

help: ## Show this help message
	@echo "Available commands:"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST) | sort

install: ## Install dependencies and pre-commit hooks
	@echo "Installing dependencies..."
	npm install
	@echo "Installing pre-commit hooks..."
	pre-commit install

lint: ## Run biome check
	npx biome ci src/ tests/

lint-fix: ## Run biome check with auto-fix
	npx biome check --write src/ tests/

format: ## Format code with biome
	npx biome format --write src/ tests/

typecheck: ## Run TypeScript type checking
	npx tsc -p tsconfig.json --noEmit

test: ## Run tests
	NODE_ENV=test npx tsx --test tests/*.test.ts

coverage: ## Run tests with a source coverage report
	npm run test:coverage

build: ## Build the plugin (typecheck + bundle)
	npm run build

clean: ## Clean build artifacts and caches
	rm -rf dist/ node_modules/.cache/

all: lint typecheck test build ## Run all checks
	@echo "All checks passed!"
