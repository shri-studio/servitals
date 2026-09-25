# SPDX-License-Identifier: AGPL-3.0-or-later
# Built from the repository root (it needs VERSION): see docker-compose.example.yml
FROM alpine:3.20

RUN apk add --no-cache bash coreutils jq curl vnstat util-linux tzdata

COPY agent/collect.sh /usr/local/lib/servitals-agent/collect.sh
COPY agent/lib /usr/local/lib/servitals-agent/lib
COPY VERSION /usr/local/lib/servitals-agent/VERSION
RUN chmod +x /usr/local/lib/servitals-agent/collect.sh

ENTRYPOINT ["/usr/local/lib/servitals-agent/collect.sh"]
