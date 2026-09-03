// Settings, stored in chrome.storage.sync.
//
// `storage` is the ONLY permission this extension asks for, and it holds no
// credential of its own.
//
// It DOES make requests — that is the point of this stage. They go to the API the
// page is already talking to, from inside the page, with the page's own session,
// and only for runs that page was already handed: see src/page/pageApi.ts for the
// ledger that enforces the last part, and src/page/pacer.ts for what keeps the volume
// down. Two of the toggles below are what turn those requests on.

import * as v from 'valibot';

import { deepLinkTemplateSchema, templateScope, type DeepLinkTemplate } from './links/deepLink';

// There is deliberately no codec-server setting in this build. Reading a payload
// means decoding it, and decoding one Temporal cannot decode for you means sending
// it to a server — the first thing here that would move workflow data off the
// machine. That is stage 03, the payload stage, where the egress gets a section of
// its own; this project's whole claim is that it learns what it knows from event
// METADATA.

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

export const DEFAULT_LINKS: DeepLinkTemplate[] = [
    {
        label: 'Logs',
        urlTemplate:
            'https://example.com/search?q={namespace}+{workflowId}&from={startTimeIso-10m}&to={endTimeIso+10m}',
    },
    DEFAULT_ACTIVITY_LINK,
];

// The stored settings, as a schema — because the previous author of this object is an
// OLDER BUILD OF THIS EXTENSION, which is the one boundary here where the untrusted
// input is our own past self. chrome.storage.sync keeps whatever that build wrote,
// including fields since renamed, retyped or deleted for being a bad idea.
//
// Every field is a v.fallback(), which is this schema's version of what the loader
// below used to spell as `stored.enabled !== false`: present and false means off, and
// anything else — absent, a string, a number an older popup wrote — means the shipped
// default. Reproducing that reading exactly is the requirement, not an approximation
// of it: a loader that turned a feature off because a stored value had the wrong type
// would present as "the feature is broken" with a correct settings screen.
//
// UNKNOWN KEYS ARE STRIPPED, and here that is the load-bearing half rather than the
// tidy half. A field that was deleted from this schema is a field no reader can reach,
// even though it is still sitting in storage: the parsed object simply does not have
// it. Stage 03 is where that matters — this build has no codec setting at all, and the
// one it will have there is an endpoint with deliberately no credential switch beside
// it, so a `codecIncludeCredentials: true` left behind by anything cannot come back.
const settingsSchema = v.object({
    // Master switch. Off = the extension writes nothing to the page.
    enabled: v.fallback(v.boolean(), true),
    // Draw parent/child connectors and re-order rows into families.
    treeEnabled: v.fallback(v.boolean(), true),
    // Per-row buttons that open this workflow in your own tools.
    linksEnabled: v.fallback(v.boolean(), true),
    // Salvaged ENTRY BY ENTRY, and never accepted or rejected whole: one malformed
    // template in a list of five costs that template, not the reader's other four.
    // A stored value that is not a list at all is the different case, and falls back
    // to the shipped pair. Same shape and same reasoning as normalizeExecutions() in
    // src/family/rows.ts, for the same reason — a collection from outside is a
    // collection of separately trustworthy things.
    links: v.fallback(
        v.pipe(
            v.array(v.unknown()),
            v.transform((entries) =>
                entries.flatMap((entry) => {
                    const link = v.safeParse(deepLinkTemplateSchema, entry);
                    return link.success ? [link.output] : [];
                }),
            ),
        ),
        // A FUNCTION, NOT THE ARRAY. valibot hands a fallback back BY REFERENCE, so a
        // bare `DEFAULT_LINKS` here would make every load that fell back share one
        // array — and the popup edits link objects in place. Editing a link in a tab
        // whose settings had fallen back would then change what the NEXT load returned,
        // for the life of the page. Fresh objects every time; settingsLoad.spec.ts pins
        // that two fallback loads share no leaf.
        () => structuredClone(DEFAULT_LINKS),
    ),
    // The two features that make requests of their OWN — one per running row each,
    // paced and cached in rowInfoServe.ts. Separate switches so the cost is
    // separately refusable; on by default, because they read no user data at all
    // (the retry badge deliberately does not read the failure message) and a
    // feature nobody turns on teaches nobody anything.
    lastEventEnabled: v.fallback(v.boolean(), true),
    retryEnabled: v.fallback(v.boolean(), true),
    // Not a feature — a migration marker. True once a human has edited the link list,
    // after which their choices are taken literally and no scope is filled in for
    // them. See withActivityScope below for what it prevents.
    linkScopesSeeded: v.fallback(v.boolean(), false),
});

export type Settings = v.InferOutput<typeof settingsSchema>;

// The shipped defaults ARE the schema's fallbacks, read out by parsing an empty
// object. One declaration rather than two, so a default cannot be changed in the
// schema and missed here — which is the mistake the note under withActivityScope is
// about, one level down.
export const DEFAULT_SETTINGS: Settings = v.parse(settingsSchema, {});

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
    // A copy, for the reason given at the links fallback above: the caller may edit
    // what it gets back, and this constant must not be what it edits.
    return [...links, { ...DEFAULT_ACTIVITY_LINK }];
}

export async function loadSettings(): Promise<Settings> {
    // chrome.storage's typings want a plain record for the defaults argument, so
    // the shape is widened here rather than cast at the call site.
    const defaults: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    // Parsed, never cast. The old version of this line asserted `as Partial<Settings>`
    // over whatever storage returned and then re-derived every field by hand; the
    // schema does the deriving, and the assertion is gone with it.
    //
    // safeParse with an explicit fallback rather than v.parse, because the object
    // ITSELF can be the wrong thing: every field inside settingsSchema recovers on its
    // own, but a non-object — which is what a storage read fails to as much as
    // succeeds to — fails the parse outright, and throwing here would take out a render
    // pass whose only symptom is "the extension stopped working".
    const parsed = v.safeParse(settingsSchema, await chrome.storage.sync.get(defaults));
    const settings = parsed.success ? parsed.output : DEFAULT_SETTINGS;
    return {
        ...settings,
        // NOT a schema default, and this is the distinction worth keeping: a fallback
        // says what an absent field means, and this says what to do about a field that
        // is present and complete and predates a feature. See withActivityScope above —
        // a stored array from before the activity template existed would otherwise make
        // the per-activity links unreachable for good, with nothing saying so. A
        // migration is application logic and stays visible as one.
        links: settings.linkScopesSeeded ? settings.links : withActivityScope(settings.links),
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
