// Settings, stored in chrome.storage.sync.
//
// `storage` is the ONLY permission this extension asks for, and it holds no
// credential of its own.
//
// It DOES make requests — that is the point of this stage. They go to the API the
// page is already talking to, from inside the page, with the page's own session,
// and only for runs that page was already handed: see src/pageApi.ts for the
// ledger that enforces the last part, and src/pacer.ts for what keeps the volume
// down. Two of the toggles below are what turn those requests on.

import type { DeepLinkTemplate } from './deepLink';

export interface Settings {
    // Master switch. Off = the extension writes nothing to the page.
    enabled: boolean;
    // Draw parent/child connectors and re-order rows into families.
    treeEnabled: boolean;
    // Per-row buttons that open this workflow in your own tools.
    linksEnabled: boolean;
    links: DeepLinkTemplate[];
    // The two features that make requests of their OWN — one per running row each,
    // paced and cached in rowInfoServe.ts. Separate switches so the cost is
    // separately refusable; on by default, because they read no user data at all
    // (the retry badge deliberately does not read the failure message) and a
    // feature nobody turns on teaches nobody anything.
    lastEventEnabled: boolean;
    retryEnabled: boolean;
}

// There is deliberately no codec-server setting in this build. Reading a payload
// means decoding it, and decoding one Temporal cannot decode for you means sending
// it to a server — the first thing here that would move workflow data off the
// machine. That is stage 03, the payload stage, where the egress gets a section of
// its own; this project's whole claim is that it learns what it knows from event
// METADATA.

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
    lastEventEnabled: true,
    retryEnabled: true,
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
        lastEventEnabled: stored.lastEventEnabled !== false,
        retryEnabled: stored.retryEnabled !== false,
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
