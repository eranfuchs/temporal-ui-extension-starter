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

import * as v from 'valibot';

import { deepLinkTemplateSchema, templateScope, type DeepLinkTemplate } from './links/deepLink';

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
// UNKNOWN KEYS ARE STRIPPED, and IN THIS BUILD that is the load-bearing half rather
// than the tidy half, because this is the build where the deleted field was real.
// `codecIncludeCredentials` was a setting here. Anybody who ran that build has a `true`
// sitting in chrome.storage.sync to this day, and nothing can delete it from their
// browser. Three independent things now have to stay true for it to be inert — the
// message shape has no such field (payloadMessages.ts), the fetch hard-wires
// `credentials: 'omit'` (apiInject.ts), and this one: the parsed settings object does
// not have the key at all, so a reader added here in future gets `undefined` rather
// than somebody's five-year-old `true`.
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
    // The per-row `{ }` button that shows a workflow's input and result. On by
    // default and it costs nothing until the panel is opened — hover, or keyboard
    // focus, or a click. One history event per QUESTION, so a running row costs one
    // request and a closed row two (input and result are different events); drawing
    // the button costs none. What it can DISPLAY is personal data, which is why
    // turning it off closes the panel and drops its cache (see content.ts).
    payloadsEnabled: v.fallback(v.boolean(), true),
    // The two features that make requests of their OWN — one per running row each,
    // paced and cached in rowInfoServe.ts. Separate switches so the cost is
    // separately refusable; on by default, because they read no user data at all
    // (the retry badge deliberately does not read the failure message) and a
    // feature nobody turns on teaches nobody anything.
    lastEventEnabled: v.fallback(v.boolean(), true),
    retryEnabled: v.fallback(v.boolean(), true),
    // A Temporal codec server, for the payloads this extension cannot read on its
    // own — `binary/encrypted` above all.
    //
    // EMPTY BY DEFAULT, AND THAT IS THE WHOLE EGRESS STORY. With this field empty no
    // payload byte leaves the machine, because this is the only place an endpoint can
    // come from: nothing is read off the page, and nothing is guessed from the
    // namespace. It is also the one setting in this repository that defaults to off
    // for a reason other than cost — see "Every feature ships on, except one" in the
    // root README.
    //
    // The fallback is therefore '' and not "leave it alone": anything stored here that
    // is not a string becomes the value that sends nothing. The recovery for a
    // half-written settings object has to be the silent one.
    codecEndpoint: v.fallback(v.string(), ''),
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
    linkScopesSeeded: v.fallback(v.boolean(), false),
});

export type Settings = v.InferOutput<typeof settingsSchema>;

// The shipped defaults ARE the schema's fallbacks, read out by parsing an empty
// object. One declaration rather than two, so a default cannot be changed in the
// schema and missed here — which is the mistake the note under withActivityScope is
// about, one level down.
//
// A FUNCTION, for the same reason the `links` fallback above is one: every caller that
// might KEEP what it gets needs its own objects. loadSettings() returns this whole
// thing when the stored object is unusable, and the popup edits a link in place — so a
// shared one made two fallback loads alias one array, and an edit in the first tab
// changed what the second load returned.
export function defaultSettings(): Settings {
    return v.parse(settingsSchema, {});
}

// The comparison value, for anything that only READS one — the storage defaults
// argument, a test asserting what shipped. Never handed to a caller as its own copy.
export const DEFAULT_SETTINGS: Settings = defaultSettings();

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
    // One fresh copy per load, used both as the storage defaults and as the recovery
    // value below. See the note on defaultSettings(): the recovery value is returned to
    // a caller that may edit it, so it cannot be the module-level constant.
    const shipped = defaultSettings();
    // chrome.storage's typings want a plain record for the defaults argument, so
    // the shape is widened here rather than cast at the call site.
    const defaults: Record<string, unknown> = { ...shipped };
    // Parsed, never cast. The old version of this line asserted `as Partial<Settings>`
    // over whatever storage returned and then re-derived every field by hand; the
    // schema does the deriving, and the assertion is gone with it. A stale
    // `codecIncludeCredentials` in storage is not in the returned object, because it is
    // not in the schema — see the note there.
    //
    // safeParse with an explicit fallback rather than v.parse, because the object
    // ITSELF can be the wrong thing: every field inside settingsSchema recovers on its
    // own, but a non-object — which is what a storage read fails to as much as
    // succeeds to — fails the parse outright, and throwing here would take out a render
    // pass whose only symptom is "the extension stopped working". Falling back to the
    // shipped defaults also means the failure mode carries an empty codecEndpoint.
    const parsed = v.safeParse(settingsSchema, await chrome.storage.sync.get(defaults));
    const settings = parsed.success ? parsed.output : shipped;
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
