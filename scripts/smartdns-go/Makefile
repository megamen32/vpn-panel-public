BIN := smartdns
TEST_BIN := test-telegram-https
PKG := .
LDFLAGS := -s -w

.PHONY: build tidy test test-smoke clean deploy

build:
	CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o $(BIN) $(PKG)

# e2e test against a running smartdns. Native Go — no bash, python, dig,
# curl. Override SMARTDNS_HOST etc. via env if needed. See
# test-telegram-https.go for full options.
#
# Built in a scratch dir to bypass the module's go.mod (which may pin a
# newer Go than the test program needs — the test program uses only
# stdlib basics and builds fine on Go 1.18+). /tmp is outside any module.
test:
	@mkdir -p /tmp/smartdns-go-test-build && \
		cp test-telegram-https.go /tmp/smartdns-go-test-build/ && \
		cd /tmp/smartdns-go-test-build && \
		CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o $(TEST_BIN) test-telegram-https.go && \
		./$(TEST_BIN)
	@rm -rf /tmp/smartdns-go-test-build

test-smoke:
	@echo "manual: start smartdns with a test config and run smoke.sh against it"

tidy:
	go mod tidy

clean:
	rm -f $(BIN)

deploy: build
	../../scripts/deploy-smartdns-unified.sh
