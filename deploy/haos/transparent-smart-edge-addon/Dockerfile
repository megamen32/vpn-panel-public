ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.22
ARG SING_BOX_VERSION=1.13.14

FROM golang:1.26.3-alpine AS builder

ARG SING_BOX_VERSION

RUN apk add --no-cache file

WORKDIR /build/smartdns
COPY smartdns/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o /out/smartdns .

WORKDIR /build/smartedge
COPY smartedge/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o /out/smart-edge .

# VLESS, TLS, WebSocket, HTTPUpgrade, and Reality are built into sing-box.
# uTLS is needed by the imported regional groups; with_clash_api enables the
# loopback clash API that route-health.sh uses to steer the ai-route selector.
RUN CGO_ENABLED=0 go install -trimpath -tags with_utls,with_clash_api \
      -ldflags "-X github.com/sagernet/sing-box/constant.Version=${SING_BOX_VERSION} -s -w -buildid=" \
      "github.com/sagernet/sing-box/cmd/sing-box@v${SING_BOX_VERSION}" \
    && /go/bin/sing-box version | grep -F "sing-box version ${SING_BOX_VERSION}" \
    && file /go/bin/sing-box | grep -F "statically linked"

FROM ${BUILD_FROM}

RUN apk add --no-cache bash iproute2 jq netcat-openbsd nftables

COPY --from=builder /out/smartdns /usr/bin/smartdns
COPY --from=builder /out/smart-edge /usr/bin/smart-edge
COPY --from=builder /go/bin/sing-box /usr/bin/sing-box
COPY rootfs /

RUN chmod 0755 /usr/bin/smartdns /usr/bin/smart-edge /usr/bin/sing-box \
      /usr/bin/run.sh /usr/bin/healthcheck.sh \
      /usr/bin/prepare-singbox-config.sh /usr/bin/validate-singbox-config.sh \
      /usr/bin/configure-runtime-inbounds.sh \
      /usr/bin/telegram-tproxy-policy.sh /usr/bin/telegram-tproxy-watchdog.sh \
      /usr/bin/route-health.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/usr/bin/healthcheck.sh"]

CMD ["/usr/bin/run.sh"]
