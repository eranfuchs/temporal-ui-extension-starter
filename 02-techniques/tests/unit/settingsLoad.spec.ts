// src/settings.ts — the stored shape, read back.
//
// THE PREVIOUS AUTHOR OF THIS OBJECT IS AN OLDER BUILD OF THIS EXTENSION, which makes
// chrome.storage.sync the one boundary in the project where the untrusted input is our
// own past self. It cannot be cleaned up: whatever any build ever wrote is still in
// that user's browser, and nothing here can delete it. So the questions are what an
// unusable value degrades to, and what a field this build does not have can still reach.
//
// The stub below returns EXACTLY what each test hands it, which is not quite what
// chrome.storage.sync.get(defaults) does — the real API merges the defaults argument in,
// so an absent key comes back already filled. That is deliberate: the loader must not
// depend on the merge, because the merge is a convenience of the API and the fallbacks
// are the thing that makes a wrong-typed value harmless. Testing through the merge
// would assert the convenience and skip the protection.
//
// Not tested: that v.boolean() rejects a string, or that v.fallback() returns its
// second argument. Those are valibot's own semantics. What is tested is every reading
// this stage's settings depend on, all of which used to be a hand-written expression.

import { afterEach, describe, expect, it } from 'vitest';

import { templateScope } from '../../src/links/deepLink';
import {
    DEFAULT_ACTIVITY_LINK,
    DEFAULT_LINKS,
    DEFAULT_SETTINGS,
    loadSettings,
    type Settings,
} from '../../src/settings';

// The cast is over the STUB, not over anything under test: @types/chrome describes the
// whole API and this supplies the one method loadSettings calls.
const load = async (stored: unknown): Promise<Settings> => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
        storage: { sync: { get: () => Promise.resolve(stored) } },
    };
    return loadSettings();
};

afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

const WORKFLOW_LINK = { label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' };

const TOGGLES = ['enabled', 'treeEnabled', 'linksEnabled', 'lastEventEnabled', 'retryEnabled'] as const;

describe('loadSettings', () => {
    it('reads a stored false as off, and anything else as the shipped default', async () => {
        for (const field of TOGGLES) {
            expect((await load({ [field]: false }))[field], field).toBe(false);
            // Present but not a boolean, or absent: an older popup that stored a string,
            // a half-written object, a field that did not exist yet. The expression this
            // replaced was `stored.x !== false`, which said "on" for every one of these,
            // and the fallback has to keep saying it — a feature that switches itself off
            // because a stored value has the wrong type presents as a broken feature,
            // with a settings screen that shows it on.
            for (const junk of [undefined, 'yes', 0, null, {}]) {
                expect((await load({ [field]: junk }))[field], `${field}=${String(junk)}`).toBe(true);
            }
        }
    });

    it('recovers one unusable field without discarding the ones beside it', async () => {
        // The difference between a fallback PER FIELD and a fallback over the whole
        // object, which the test above cannot see: both give the shipped default for the
        // junk field. Only the per-field one keeps the neighbour a human deliberately
        // switched off, and a settings screen that silently re-enables four features
        // because a fifth is malformed is worse than one that fails visibly.
        for (const field of TOGGLES) {
            const neighbour = field === 'enabled' ? 'treeEnabled' : 'enabled';
            const settings = await load({ [field]: 'yes', [neighbour]: false, linkScopesSeeded: true });
            expect(settings[field], field).toBe(true);
            expect(settings[neighbour], `${field} took out ${neighbour}`).toBe(false);
            expect(settings.linkScopesSeeded, `${field} took out linkScopesSeeded`).toBe(true);
        }
    });

    it('treats only a literal true as the migration marker', async () => {
        // The one field whose default is off, and the one that must not be inferred:
        // anything other than `true` means "no human has edited this list yet", which is
        // what licenses the backfill below.
        expect((await load({ linkScopesSeeded: true })).linkScopesSeeded).toBe(true);
        for (const junk of [undefined, false, 'true', 1]) {
            expect((await load({ linkScopesSeeded: junk })).linkScopesSeeded, String(junk)).toBe(false);
        }
    });

    it('salvages the stored link list entry by entry', async () => {
        // One malformed template costs that template and not the reader's other ones.
        // A list is a collection of separately trustworthy things, and rejecting it whole
        // would turn one bad row in a settings screen into "all my links are gone".
        const links = (await load({ links: [WORKFLOW_LINK, { label: 7 }, null, 'nope'], linkScopesSeeded: true })).links;
        expect(links).toEqual([WORKFLOW_LINK]);
    });

    it('gives every fallback load its own objects, whichever of the two fallbacks ran', async () => {
        // valibot hands a fallback back BY REFERENCE. With a bare array as the
        // fallback, both loads below returned the SAME array holding the SAME link
        // objects — and popup.ts edits a link in place, so one popup's edit changed
        // what the next load produced, without anything being stored. Reproduced
        // before the fix; this pins the fix rather than the library.
        //
        // TWO FALLBACKS CAN RUN HERE, and the first version of this test drove only one
        // of them. `links: 'corrupt'` takes the field fallback inside the schema. A stored
        // value that is not an object at all fails the parse outright and takes
        // loadSettings' own recovery, which was still handing back the module-level
        // DEFAULT_SETTINGS — so two loads went on sharing their leaves by the other
        // route, with this test green. Both are driven below, and DEFAULT_SETTINGS is
        // asserted not to be what a caller gets: it is the one object a popup edit could
        // corrupt for every later load in the page.
        for (const stored of [{ links: 'corrupt', linkScopesSeeded: true }, null]) {
            const which = JSON.stringify(stored);
            const first = (await load(stored)).links;
            const second = (await load(stored)).links;

            expect(first, which).toEqual(second);
            expect(first, which).not.toBe(second);
            expect(first[0], which).not.toBe(second[0]);
            expect(first, which).not.toBe(DEFAULT_SETTINGS.links);
            expect(first[0], which).not.toBe(DEFAULT_SETTINGS.links[0]);

            // The consequence, stated as the thing a reader would actually notice.
            first[0]!.label = 'edited in one popup';
            expect(second[0]!.label, which).not.toBe('edited in one popup');
            expect(DEFAULT_SETTINGS.links[0]!.label, which).not.toBe('edited in one popup');
        }
    });

    it('falls back to the shipped pair when the stored links are not a list at all', async () => {
        for (const junk of [undefined, 'nope', 42, {}]) {
            expect((await load({ links: junk, linkScopesSeeded: true })).links, String(junk)).toEqual(DEFAULT_LINKS);
        }
        // An empty list is the different case, and stays empty: it is a deliberate
        // "no links", not a broken value. Only the marker stops the backfill here — see
        // the last test in tests/unit/settings.spec.ts.
        expect((await load({ links: [], linkScopesSeeded: true })).links).toEqual([]);
    });

    it('backfills the activity scope until a human has edited the list', async () => {
        // The live-tenant bug, from the loader's side rather than the pure function's:
        // a stored array written before the activity template existed has no marker,
        // because the marker is set by the popup on the first edit.
        const seeded = await load({ links: [WORKFLOW_LINK] });
        expect(seeded.links.filter((l) => templateScope(l.urlTemplate) === 'activity')).toEqual([
            DEFAULT_ACTIVITY_LINK,
        ]);
        const edited = await load({ links: [WORKFLOW_LINK], linkScopesSeeded: true });
        expect(edited.links).toEqual([WORKFLOW_LINK]);
    });

    it('cannot be given a setting this stage does not have', async () => {
        // THIS BUILD HAS NO CODEC SETTING AT ALL — no endpoint, no credential switch —
        // and the stored object is the one place a field could arrive from outside the
        // source tree. So the assertion is that the loaded object does not HAVE the keys:
        // whatever is in storage, a reader added here in future gets undefined rather
        // than a host somebody else stored. Reading a payload is stage 03's lesson, and
        // it is a stage boundary rather than a naming convention.
        const settings = await load({ codecEndpoint: 'https://codec.example.com', codecIncludeCredentials: true });
        expect(Object.keys(settings).sort()).toEqual([
            'enabled',
            'lastEventEnabled',
            'linkScopesSeeded',
            'links',
            'linksEnabled',
            'retryEnabled',
            'treeEnabled',
        ]);
    });

    it('recovers from a stored object that is not an object', async () => {
        // Every field recovers on its own, but the container can be wrong too, and a
        // throw here would happen inside a render pass whose only symptom is "the
        // extension stopped working".
        for (const junk of ['nope', 42, null, undefined, ['links']]) {
            const settings = await load(junk);
            expect(settings.enabled, String(junk)).toBe(true);
            expect(settings.links, String(junk)).toEqual(DEFAULT_LINKS);
        }
    });
});
