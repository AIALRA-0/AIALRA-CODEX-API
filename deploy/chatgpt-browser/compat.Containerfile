# Low-disk Browser-only rebuild. The base image is supplied as an immutable
# production digest so this path does not repeat the full monorepo build.
ARG BASE_BROWSER_IMAGE
FROM ${BASE_BROWSER_IMAGE}

ARG RELEASE_REVISION=unknown
LABEL org.opencontainers.image.revision="${RELEASE_REVISION}"

USER root
RUN set -eu \
    && grep -Fq "        let autoconnect = WebUtil.getConfigVar('autoconnect', false);" /usr/share/novnc/app/ui.js \
    && sed -i "s#        let autoconnect = WebUtil.getConfigVar('autoconnect', false);#        let autoconnect = WebUtil.getConfigVar('autoconnect', false); const browserPath = window.location.pathname; if (autoconnect === false \&\& ['/chatgpt-browser/vnc.html','/chatgpt-browser-b/vnc.html','/chatgpt-browser-c/vnc.html','/chatgpt-browser-d/vnc.html'].includes(browserPath)) autoconnect = true;#" /usr/share/novnc/app/ui.js \
    && grep -Fq "autoconnect === false" /usr/share/novnc/app/ui.js \
    && grep -Fq "        url += '/' + path;" /usr/share/novnc/app/ui.js \
    && sed -i "s#        url += '/' + path;#        if (path === 'websockify') { const prefix = window.location.pathname.match(new RegExp('^/(chatgpt-browser(?:-[b-d])?)/')); if (prefix) path = prefix[1] + '/websockify'; } url += '/' + path;#" /usr/share/novnc/app/ui.js \
    && grep -Fq "if (path === 'websockify')" /usr/share/novnc/app/ui.js
USER browser
