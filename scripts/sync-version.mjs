import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const manifests = [
  'plugins/claude/agent-remote/.claude-plugin/plugin.json',
  'plugins/codex/agent-remote/.codex-plugin/plugin.json',
];

for (const file of manifests) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.version = pkg.version;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
