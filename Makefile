
##

API=api/*.js
TESTS=tests/*.js
TOOLS=tools/*.js tools/lib/*/*.js

prettier:
	prettier --write $(API) $(TESTS) $(TOOLS)
lint:
	eslint --no-ignore $(API) $(TESTS) $(TOOLS)
.PHONY: prettier lint

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

monitor:
	tools/stiga-monitor.js \
		--monitor --capture 

##

SYSTEMD_DIR = /etc/systemd/system
define install_systemd_service
	-systemctl stop $(1) 2>/dev/null || true
	-systemctl disable $(1) 2>/dev/null || true
	cp $(2).service $(SYSTEMD_DIR)/$(1).service
	systemctl daemon-reload
	systemctl enable $(1)
	systemctl start $(1) || echo "Warning: Failed to start $(1)"
endef
service_install: tools/stiga-monitor.service
	$(call install_systemd_service,stiga-monitor,tools/stiga-monitor)
service_watch:
	journalctl -u stiga-monitor -f
service_restart:
	systemctl restart stiga-monitor
.PHONY: service_install
.PHONY: service_watch service_restart

