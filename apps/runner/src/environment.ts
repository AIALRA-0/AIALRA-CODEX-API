export function codexEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed = [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => (environment[name] ? [[name, environment[name] as string]] : [])),
  );
}
