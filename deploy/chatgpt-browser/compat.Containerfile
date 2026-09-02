# Low-disk Browser-only rebuild. The base image is supplied as an immutable
# production digest so this path does not repeat the full monorepo build.
ARG BASE_BROWSER_IMAGE
FROM ${BASE_BROWSER_IMAGE}

ARG RELEASE_REVISION=unknown
LABEL org.opencontainers.image.revision="${RELEASE_REVISION}"

USER root
RUN set -eu \
    && grep -Fq "        let autoconnect = WebUtil.getConfigVar('autoconnect', false);" /usr/share/novnc/app/ui.js \
    && grep -Fq "if (path === 'websockify')" /usr/share/novnc/app/ui.js \
    && sed -i "s#        if (path === 'websockify') {.*#        const routedPath = path === 'websockify' ? (() => { const prefix = window.location.pathname.match(new RegExp('^/(chatgpt-browser(?:-[b-d])?)/')); return prefix ? prefix[1] + '/websockify' : path; })() : path; url += '/' + routedPath;#" /usr/share/novnc/app/ui.js \
    && sed -i "/        let autoconnect = WebUtil.getConfigVar('autoconnect', false);/a\\        const browserPath = window.location.pathname; if (autoconnect === false \&\& ['/chatgpt-browser/vnc.html','/chatgpt-browser-b/vnc.html','/chatgpt-browser-c/vnc.html','/chatgpt-browser-d/vnc.html'].includes(browserPath)) autoconnect = true;" /usr/share/novnc/app/ui.js \
    && grep -Fq "autoconnect === false" /usr/share/novnc/app/ui.js \
    && grep -Fq "const routedPath" /usr/share/novnc/app/ui.js \
    && ! grep -Fq "if (prefix) path =" /usr/share/novnc/app/ui.js
USER browser
