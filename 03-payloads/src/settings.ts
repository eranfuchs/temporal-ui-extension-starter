// Settings, stored in chrome.storage.sync.
//
// `storage` is the ONLY permission this extension asks for, and it holds no
// credential of its own.
//
// It DOES make requests. Most of them go to the API the page is already talking to,
// from inside the page, with the page's own session, and only for runs that page was
// already handed: see src/page/pageApi.ts for the ledger that enforces the last part, and
// src/page/requestPacing.ts for what keeps the volume down.
//
// AND ONE FIELD HERE IS DIFFERENT FROM EVERY OTHER SETTING IN THIS REPOSITORY.
// `codecEndpoint` is the only one that names a host, and therefore the only one that
// can make workflow data leave the machine. It is empty by default, and the empty
// value is not merely a sensible default — it is the reason the sentence "nothing
// leaves your browser unless you fill this in" is checkable rather than a promise.
// Read the note on the field itself before widening what it accepts.

import { templateScope, type DeepLinkTemplate } from './links/deepLink';

export interface Settings {
    // Master switch. Off = the extension writes nothing to the page.
    enabled: boolean;
    // Draw parent/child connectors and re-order rows into families.
    treeEnabled: boolean;
    // Per-row buttons that open this workflow in your own tools.
    linksEnabled: boolean;
    links: DeepLinkTemplate[];
    // The per-row `{ }` button that shows a workflow's input and result. On by
    // default and it costs nothing until the panel is opened — hover, or keyboard
    // focus, or a click. One history event per QUESTION, so a running row costs one
    // request and a closed row two (input and result are different events); drawing
    // the button costs none. What it can DISPLAY is personal data, which is why
    // turning it off closes the panel and drops its cache (see content.ts).
    payloadsEnabled: boolean;
    // The two features that make requests of their OWN — one per running row each,
    // paced and cached in rowInfoServe.ts. Separate switches so the cost is
    // separately refusable; on by default, because they read no user data at all
    // (the retry badge deliberately does not read the failure message) and a
    // feature nobody turns on teaches nobody anything.
    lastEventEnabled: boolean;
    retryEnabled: boolean;
    // A Temporal codec server, for the payloads this extension cannot read on its
    // own — `binary/encrypted` above all.
    //
    // EMPTY BY DEFAULT, AND THAT IS THE WHOLE EGRESS STORY. With this field empty no
    // payload byte leaves the machine, because this is the only place an endpoint can
    // come from: nothing is read off the page, and nothing is guessed from the
    // namespace. It is also the one setting in this repository that defaults to off
    // for a reason other than cost — see "Every feature ships on, except one" in the
    // root README.
    codecEndpoint: string;
    // AND THAT IS THE WHOLE CODEC CONFIG — one field, no credential switch.
    //
    // There is deliberately no "pass my access token" and no "send cookies" setting.
    // Temporal's own UI has both; this extension had both. The endpoint is chosen
    // through a channel any script on the page can write to, and a credential flag
    // beside a host from an untrusted channel is a credential someone else can aim.
    // Defaulting such a flag to off would not have fixed it, because the value that
    // reaches the fetch comes from the message and not from here. See the CodecConfig
    // note in payloadMessages.ts, which is longer than this one because a deletion
    // leaves nothing behind to read.
    //
    // Not a feature — a migration marker. True once a human has edited the link list,
    // after which their choices are taken literally and no scope is filled in for
    // them. See withActivityScope below for what it prevents.
    linkScopesSeeded: boolean;
}

// The default links point at example.com on purpose: it is a reserved
// documentation domain, so they cannot accidentally send a workflow id to someone
// else's server, and clicking one once makes the feature explain itself. Replace
// the host and the query shape with your log tool's and the button is yours.
//
// TWO of them, one per scope, and the second one is there so that per-activity links
// EXIST without being configured. The alternative was shipping only the workflow
// template and printing a line on the page telling the reader to add an activity
// token if they wanted the other kind — which is a feature explaining how to
// configure itself on the page where it could simply have worked. See the note at the
// top of src/detail/detailLinks.ts.
//
// The activity template is also the worked example of the identity rule in
// deepLink.ts: it is keyed on `{activityId}`, NOT on `{activityType}` — a type
// repeats within a run, so a link built from it matches every execution of it — and
// it carries the activity's own window, which is what makes the search exact on a
// backend that indexes neither id.
//
// BOTH templates lead with `{namespace}`, and that is not decoration. A workflow id
// is unique only WITHIN a namespace, so the same id exists in staging and in
// production, and one log backend usually holds both. A query on the id alone
// therefore returns rows from an environment the reader is not looking at, with
// nothing marking which is which. The namespace is the cheapest thing that
// distinguishes them, and it is resolved from the page's own URL — so a link built
// on the staging list cannot quietly search production.
export const DEFAULT_ACTIVITY_LINK: DeepLinkTemplate = {
    label: 'Activity logs',
    urlTemplate:
        'https://example.com/search?q={namespace}+{workflowId}+{activityId}&from={activityScheduledIso-1m}&to={activityClosedIso+1m}',
};

export const DEFAULT_SETTINGS: Settings = {
    enabled: true,
    treeEnabled: true,
    linksEnabled: true,
    links: [
        {
            label: 'Logs',
            urlTemplate:
                'https://example.com/search?q={namespace}+{workflowId}&from={startTimeIso-10m}&to={endTimeIso+10m}',
        },
        DEFAULT_ACTIVITY_LINK,
    ],
    payloadsEnabled: true,
    lastEventEnabled: true,
    retryEnabled: true,
    codecEndpoint: '',
    linkScopesSeeded: false,
};

// A NEW DEFAULT DOES NOT REACH AN EXISTING USER. This is the bug that made the
// per-activity links invisible on a live tenant where everything else worked, and it
// is worth reading before adding any other defaulted array to this file.
//
// `links` is stored as one array, and the popup writes the whole array on every edit.
// So anybody who had used this extension before the activity template was added — or
// who edited the workflow template once — has a stored array that contains no
// activity-scoped template at all. loadSettings takes the stored array wholesale, and
// `templatesInScope(links, 'activity')` is then legitimately empty: no template asks
// for an activity, so no per-activity link is ever built. Every part of the machinery
// works and nothing is on screen. Reloading does not help, because the stored array
// is exactly what it was.
//
// The fix is to treat the SCOPE as the default rather than the array: if nothing in
// the stored links can produce an activity link, add the one that can.
//
// Applied in memory only, and skipped once `linkScopesSeeded` is set — which the popup
// sets the first time a human edits the list. That is the difference between "you have
// never had this link" and "you deleted it": without the flag, deleting the activity
// template would resurrect it on the next page load, which is a settings screen that
// argues with you.
export function withActivityScope(links: DeepLinkTemplate[]): DeepLinkTemplate[] {
    if (links.some((link) => templateScope(link.urlTemplate) === 'activity')) return links;
    return [...links, DEFAULT_ACTIVITY_LINK];
}

export async function loadSettings(): Promise<Settings> {
    // chrome.storage's typings want a plain record for the defaults argument, so
    // the shape is widened here rather than cast at the call site.
    const defaults: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    const stored = (await chrome.storage.sync.get(defaults)) as Partial<Settings>;
    // Guard the array shape explicitly: a half-written settings object from an
    // older build must degrade to the default, not throw inside a render pass
    // where the only symptom would be "the extension stopped working".
    const links = Array.isArray(stored.links) ? (stored.links as DeepLinkTemplate[]) : DEFAULT_SETTINGS.links;
    const usable = links.filter((l) => l && typeof l.label === 'string' && typeof l.urlTemplate === 'string');
    return {
        enabled: stored.enabled !== false,
        treeEnabled: stored.treeEnabled !== false,
        linksEnabled: stored.linksEnabled !== false,
        // See withActivityScope above: a stored array from before the activity
        // template existed would otherwise make the per-activity links unreachable
        // for good, with nothing saying so.
        links: stored.linkScopesSeeded === true ? usable : withActivityScope(usable),
        linkScopesSeeded: stored.linkScopesSeeded === true,
        payloadsEnabled: stored.payloadsEnabled !== false,
        lastEventEnabled: stored.lastEventEnabled !== false,
        retryEnabled: stored.retryEnabled !== false,
        // Anything that is not a string becomes the empty string, which means "no
        // codec server" and therefore no egress. The fallback for a half-written
        // settings object has to be the one that sends nothing.
        codecEndpoint: typeof stored.codecEndpoint === 'string' ? stored.codecEndpoint : '',
        // A `codecIncludeCredentials` left in storage by an older build is not read
        // here and has nothing to reach: the field is gone from Settings, from the
        // message shape, and from the fetch. Deleting the reader is what makes a
        // stale stored `true` inert.
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
