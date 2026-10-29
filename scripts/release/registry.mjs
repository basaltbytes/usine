export async function unpublishedPackages(packages, registry) {
  const pending = [];
  for (const { name, version } of packages) {
    const url = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry);
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) {
      pending.push(`${name}@${version}`);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Registry check failed for ${name}@${version}: HTTP ${response.status}`);
    }
    const manifest = await response.json();
    if (manifest?.name !== name || manifest?.version !== version) {
      throw new Error(`Registry returned unexpected metadata for ${name}@${version}`);
    }
  }
  return pending;
}
