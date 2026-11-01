export const environmentTemplate = `# Optional overrides. Shell variables take precedence over this file.
# https://docs.usine.dev/reference/configuration/cli/#environment-variables

# HTTP listener and public HTTPS origin (when using a reverse proxy).
# USINE_PORT=7331
# USINE_ORIGIN=https://usine.example.com
# USINE_LOG_LEVEL=info

# Temporary instances only: runtime data disappears when temporary storage is cleared.
# USINE_ALLOW_VOLATILE_INSTANCE=1
# TMPDIR=/tmp

# Setup saves GitHub App credentials in .usine/github-app.json.
# Uncomment only to override those credentials.
# USINE_GITHUB_APP_ID=
# USINE_GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----\\n"
# USINE_GITHUB_CLIENT_ID=
# USINE_GITHUB_CLIENT_SECRET=
# USINE_GITHUB_WEBHOOK_SECRET=

# Optional worker credentials; reference their variable names in worker settings.
# USINE_GATEWAY_ADMIN_TOKEN=
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=

# Optional tracing resource attributes.
# OTEL_RESOURCE_ATTRIBUTES=service.name=usine
`;
