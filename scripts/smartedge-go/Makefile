BIN := smart-edge
PKG := .
LDFLAGS := -s -w

.PHONY: build tidy test clean

build:
	CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o $(BIN) $(PKG)

tidy:
	go mod tidy

test:
	@echo "manual: LISTEN_PORT=19443 ./smart-edge ; in another shell: curl --resolve vpn2.bezrabotnyi.com:19443:127.0.0.1 https://vpn2.bezrabotnyi.com:19443/"

clean:
	rm -f $(BIN)
