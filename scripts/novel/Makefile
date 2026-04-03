SHELL_SCRIPTS = run-daily.sh

# Default target: run tests.
.PHONY: all clean test
all: test

clean:
	@:

# Validates shell script syntax (bash -n) and runs shellcheck for static analysis.
test:
	@bash -n $(SHELL_SCRIPTS) && echo "bash -n: OK"
	@shellcheck $(SHELL_SCRIPTS)
