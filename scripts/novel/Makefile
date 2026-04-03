SHELL_SCRIPTS = run-daily.sh

.PHONY: test
test:
	@bash -n $(SHELL_SCRIPTS) && echo "bash -n: OK"
	@shellcheck $(SHELL_SCRIPTS) || true
