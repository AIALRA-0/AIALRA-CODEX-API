# Low-disk Browser-only rebuild. The base image is supplied as an immutable
# production digest so this path does not repeat the full monorepo build.
ARG BASE_BROWSER_IMAGE
FROM ${BASE_BROWSER_IMAGE}

ARG RELEASE_REVISION=unknown
LABEL org.opencontainers.image.revision="${RELEASE_REVISION}"

USER root
RUN set -eu \
    && grep -Fq "        url += '/' + path;" /usr/share/novnc/app/ui.js \
    && sed -i "s#        url += '/' + path;#        if (path === 'websockify') { const prefix = window.location.pathname.match(new RegExp('^/(chatgpt-browser(?:-[b-d])?)/')); if (prefix) path = prefix[1] + '/websockify'; } url += '/' + path;#" /usr/share/novnc/app/ui.js \
    && grep -Fq "if (path === 'websockify')" /usr/share/novnc/app/ui.js
USER browser
