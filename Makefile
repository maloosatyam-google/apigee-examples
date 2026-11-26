.PHONY: all validate test clean

all: validate test

validate:
	@echo "==> Validating all Apigee proxy bundles and API products (--strict)..."
	@for proxy_dir in $$(find . -type d -name apiproxy -not -path '*/.build/*'); do \
		parent=$$(dirname "$$proxy_dir"); \
		echo "  [*] $$parent"; \
		python3 scripts/validate_bundle.py "$$parent" --strict; \
	done

test:
	@echo "==> Running offline unit tests across examples..."
	@for test_file in $$(find . -path '*/tests/*.test.mjs' | sort); do \
		echo "  [*] $$test_file"; \
		node --test "$$test_file"; \
	done

clean:
	@find . -type d -name ".build" -prune -exec rm -rf {} +
	@find . -type d -name "dist" -prune -exec rm -rf {} +
