
##

API=api/*.js
TESTS=tests/*.js
TOOLS=tools/*.js tools/lib/*/*.js

prettier:
	prettier --write $(API) $(TESTS) $(TOOLS)
lint:
	eslint --no-ignore $(API) $(TESTS) $(TOOLS)

checks: prettier lint

.PHONY: prettier lint checks

##

export:
	GOOGLE_IMPERSONATE_EMAIL=matt@gream-home.net tools/stiga-database-exporter.js \
		data/capture.db \
		--format sheets --credentials ./.credentials --sheet-name "stiga capture" \
		--tail 10000

display:
	tools/stiga-position-viewer.js \
		data/capture.db \
		--lat 59.661918668015225 --lon 12.996299751022182 \
		--apikey `cat ./.apikey` --port 4000

client:
	tools/stiga-monitor.js --connect

monitor:
	tools/stiga-monitor.js \
		--monitor --capture 

##

SYSTEMD_DIR = /etc/systemd/system
# Prefer a host-specific unit file (kept out of git via .gitignore) when present, so the
# committed default can be overridden per-host without touching tracked files.
HOSTNAME := $(shell hostname)
MONITOR_SERVICE_HOST = tools/stiga-monitor.$(HOSTNAME).service
MONITOR_SERVICE_DEFAULT = tools/stiga-monitor.service
MONITOR_SERVICE = $(if $(wildcard $(MONITOR_SERVICE_HOST)),$(MONITOR_SERVICE_HOST),$(MONITOR_SERVICE_DEFAULT))
define install_systemd_service
	-systemctl stop $(1) 2>/dev/null || true
	-systemctl disable $(1) 2>/dev/null || true
	cp $(2) $(SYSTEMD_DIR)/$(1).service
	systemctl daemon-reload
	systemctl enable $(1)
	systemctl start $(1) || echo "Warning: Failed to start $(1)"
endef
service_install: $(MONITOR_SERVICE)
	@echo "installing systemd unit from $(MONITOR_SERVICE)"
	$(call install_systemd_service,stiga-monitor,$(MONITOR_SERVICE))
service_watch:
	journalctl -u stiga-monitor -f
service_restart:
	systemctl restart stiga-monitor
.PHONY: service_install
.PHONY: service_watch service_restart

