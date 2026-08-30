// Settings, stored in chrome.storage.sync.
//
// `storage` is the ONLY permission this extension asks for. It reads no hosts,
// holds no credentials and makes no requests of its own — see docs/how-it-works.md.

import type { DeepLinkTemplate } from './deepLink';

export interface Settings {
    // Master switch. Off = the extension writes nothing to the page.
    enabled: boolean;
    // Draw parent/child connectors and re-order rows into families.
    treeEnabled: boolean;
    // Per-row buttons that open this workflow in your own tools.
    linksEnabled: boolean;
    links: DeepLinkTemplate[];
}

// The default link points at example.com on purpose: it is a reserved
// documentation domain, so it cannot accidentally send a workflow id to someone
// else's server, and clicking it once makes the feature explain itself. Replace
// the host and the query shape with your log tool's and the button is yours.
export const DEFAULT_SETTINGS: Settings = {
    enabled: true,
    treeEnabled: true,
    linksEnabled: true,
    links: [
        {
            label: 'Logs',
            urlTemplate:
                'https://example.com/search?q={workflowId}&from={startTimeIso-10m}&to={endTimeIso+10m}',
        },
    ],
};

export async function loadSettings(): Promise<Settings> {
    // chrome.storage's typings want a plain record for the defaults argument, so
    // the shape is widened here rather than cast at the call site.
    const defaults: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    const stored = (await chrome.storage.sync.get(defaults)) as Partial<Settings>;
    // Guard the array shape explicitly: a half-written settings object from an
    // older build must degrade to the default, not throw inside a render pass
    // where the only symptom would be "the extension stopped working".
    const links = Array.isArray(stored.links) ? (stored.links as DeepLinkTemplate[]) : DEFAULT_SETTINGS.links;
    return {
        enabled: stored.enabled !== false,
        treeEnabled: stored.treeEnabled !== false,
        linksEnabled: stored.linksEnabled !== false,
        links: links.filter((l) => l && typeof l.label === 'string' && typeof l.urlTemplate === 'string'),
    };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
    await chrome.storage.sync.set(patch);
}

// Fires in every context that has the extension loaded, including the content
// script — so toggling a switch in the popup takes effect on the open tab
// without a reload.
export function onSettingsChanged(callback: (settings: Settings) => void): void {
    chrome.storage.onChanged.addListener((_changes, area) => {
        if (area !== 'sync') return;
        void loadSettings().then(callback);
    });
}
