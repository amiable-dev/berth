import { defineConfig } from 'vitepress';

const guide = [
  { text: 'Getting started', link: '/guide/getting-started' },
  { text: 'Concepts', link: '/guide/concepts' },
  { text: 'Day to day', link: '/guide/day-to-day' },
  { text: 'Claude Code and agents', link: '/guide/claude-code' },
  { text: 'The dashboard', link: '/guide/dashboard' },
  { text: 'Troubleshooting', link: '/guide/troubleshooting' },
];
const reference = [
  { text: 'CLI', link: '/reference/cli' },
  { text: 'Policy file', link: '/reference/policy' },
  { text: 'JSON and MCP', link: '/reference/json' },
  { text: 'Safety model', link: '/reference/security' },
];
const design = [
  { text: 'Design document', link: '/DESIGN' },
  { text: 'Research: the OSS landscape', link: '/RESEARCH' },
  {
    text: 'Architecture decisions',
    collapsed: true,
    items: [
      { text: 'ADR-001 Advisory, not enforcement', link: '/adr/ADR-001-advisory-registry-not-enforcement' },
      { text: 'ADR-002 The decodable port scheme', link: '/adr/ADR-002-decodable-port-scheme' },
      { text: 'ADR-003 Daemonless ledger, lock-free claims', link: '/adr/ADR-003-daemonless-ledger-and-lock-free-claims' },
      { text: 'ADR-004 Truth sources and attribution', link: '/adr/ADR-004-truth-sources-and-attribution' },
      { text: 'ADR-005 Node 20, single bundle', link: '/adr/ADR-005-node20-single-bundle-zero-runtime-deps' },
      { text: 'ADR-006 Self-configuring CLI', link: '/adr/ADR-006-self-configuring-cli' },
      { text: 'ADR-007 Plugin, skills and MCP', link: '/adr/ADR-007-plugin-skills-and-mcp' },
      { text: 'ADR-008 Agent guardrails', link: '/adr/ADR-008-agent-guardrails' },
    ],
  },
];

export default defineConfig({
  title: 'berth',
  description: 'Advisory port registry, reconciler and dashboard for concurrent agent sessions on one machine.',
  base: '/berth/',
  lang: 'en-GB',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['**/node_modules/**', 'images/README.md', 'adr/ADR-000-template.md'],
  ignoreDeadLinks: true,
  head: [['link', { rel: 'icon', href: '/berth/favicon.svg', type: 'image/svg+xml' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/cli' },
      { text: 'Design', link: '/DESIGN' },
      { text: 'npm', link: 'https://www.npmjs.com/package/@amiable-dev/berth' },
    ],
    sidebar: {
      '/guide/': [{ text: 'Guide', items: guide }, { text: 'Reference', items: reference }],
      '/reference/': [{ text: 'Reference', items: reference }, { text: 'Guide', items: guide }],
      '/': [{ text: 'Design', items: design }, { text: 'Guide', items: guide }],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/amiable-dev/berth' }],
    editLink: { pattern: 'https://github.com/amiable-dev/berth/edit/main/docs/:path', text: 'Edit this page on GitHub' },
    search: { provider: 'local' },
    footer: { message: 'Released under the MIT licence.', copyright: '© 2026 Amiable Dev' },
    outline: [2, 3],
  },
});
