SHELL_SCRIPTS = run-daily.sh

# Validates shell script syntax (bash -n) and runs shellcheck for static analysis.
.PHONY: test
test:
	@bash -n $(SHELL_SCRIPTS) && echo "bash -n: OK"
	@shellcheck $(SHELL_SCRIPTS) || true
