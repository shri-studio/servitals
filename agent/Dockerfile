# SPDX-License-Identifier: AGPL-3.0-or-later
FROM alpine:3.20

RUN apk add --no-cache bash coreutils jq vnstat docker-cli util-linux tzdata

COPY collect.sh /usr/local/bin/collect.sh
RUN chmod +x /usr/local/bin/collect.sh

ENTRYPOINT ["/usr/local/bin/collect.sh"]
