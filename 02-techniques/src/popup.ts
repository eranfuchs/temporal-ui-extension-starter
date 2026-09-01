// The toolbar popup: the settings UI, and an honest answer to "is it working?".
//
// The status line matters more than it looks. Every silent failure this
// extension can have — wrong page, a filter that returned children whose parents
// are absent, an API URL shape that changed — presents identically as "the tree
// does nothing". Showing rows-seen, rows-matched and families-found separates
// those three cases in one glance.

import { KNOWN_TOKENS, templateIsSafe, templatesInScope, type DeepLinkTemplate } from './deepLink';
import { MAX_ACTIVITIES } from './detail';
import { loadSettings, saveSettings, type Settings } from './settings';

interface PageStats {
    onListPage: boolean;
    namespace: string | null;
    rowsSeen: number;
    rowsMatched: number;
    rowsIndented: number;
    rowsKnown: number;
    families: number;
    retryBadges: number;
    // How many runs the page has asked Temporal about since it loaded. The only
    // number in this extension that represents requests WE made rather than
    // requests we watched, which is exactly why it is on screen.
    runsAsked: number;
    // A single workflow's own page, where the deep links live instead. Reported
    // separately because "no workflow table" is the right answer there and reads
    // like a failure — see showStatus().
    onDetailPage: boolean;
    activitiesKnown: number;
    activityPanelsLinked: number;
    // The bar could not find the page's own layout and is parked in a corner. The
    // one state that otherwise looks like nothing at all — see the note at the top
    // of src/detailLinks.ts, where a stale anchor cost two diagnoses.
    linksAdrift: boolean;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let settings: Settings;

async function main(): Promise<void> {
    $('version').textContent = `v${chrome.runtime.getManifest().version}`;
    $('tokens').textContent = KNOWN_TOKENS.map((t) => `{${t}}`).join(' ');

    settings = await loadSettings();
    bindToggle('enabled');
    bindToggle('treeEnabled');
    bindToggle('linksEnabled');
    bindToggle('lastEventEnabled');
    bindToggle('retryEnabled');
    renderLinks();
    renderLinkScopeNote();

    $('add-link').addEventListener('click', () => {
        settings.links = [...settings.links, { label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' }];
        renderLinks();
        saveLinks();
    });

    void showStatus();
}

type BooleanSetting = {
    [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

function bindToggle(key: BooleanSetting): void {
    const input = $<HTMLInputElement>(key);
    input.checked = settings[key];
    input.addEventListener('change', () => {
        settings[key] = input.checked;
        void saveSettings({ [key]: input.checked });
    });
}

// The ONE way this file writes the link list, because every write carries a second
// fact: a human has now curated these, so stop filling in a missing scope for them
// (settings.ts, withActivityScope). Four call sites used to write `links` alone; a
// fifth added later without the marker would quietly restore the bug where deleting
// the activity template brings it back on the next page load.
function saveLinks(): void {
    settings.linkScopesSeeded = true;
    void saveSettings({ links: settings.links, linkScopesSeeded: true });
    renderLinkScopeNote();
}

// Says which SCOPES the current list can actually produce, next to the list itself.
// A reader looking for a per-activity link that never appears has no way to know the
// reason is "no template mentions an activity token" — the templates look fine, the
// page looks fine, and the two facts are three files apart.
function renderLinkScopeNote(): void {
    const note = $('link-scopes');
    const activity = templatesInScope(settings.links, 'activity').length;
    const workflow = settings.links.length - activity;
    note.textContent =
        activity === 0
            ? `${workflow} workflow link${workflow === 1 ? '' : 's'}, no activity link. A link only appears on an activity if its template names an activity token — {activityId} is the one to use.`
            : `${workflow} workflow link${workflow === 1 ? '' : 's'}, ${activity} activity link${activity === 1 ? '' : 's'}. Activity links appear on a workflow's own page, on the row labelled "Activity Id".`;
}

function renderLinks(): void {
    const host = $('links');
    host.textContent = '';
    settings.links.forEach((link, index) => {
        host.appendChild(linkRow(link, index));
    });
}

function linkRow(link: DeepLinkTemplate, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'link-row';

    const warning = document.createElement('div');
    warning.className = 'warning';

    const label = textInput(link.label, 'Button label', (value) => {
        settings.links[index]!.label = value;
        saveLinks();
    });
    // example.com, not a made-up hostname: it is the reserved documentation
    // domain (RFC 2606), so a placeholder in a public repo can never be read as
    // a real internal address — by a person or by the leak gate.
    const template = textInput(link.urlTemplate, 'https://logs.example.com/?q={workflowId}', (value) => {
        settings.links[index]!.urlTemplate = value;
        showTemplateVerdict(template, warning);
        saveLinks();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove this link';
    remove.addEventListener('click', () => {
        settings.links = settings.links.filter((_, i) => i !== index);
        renderLinks();
        saveLinks();
    });

    row.append(label, template, remove, warning);
    showTemplateVerdict(template, warning);
    return row;
}

// Says out loud, where the template was typed, that it cannot produce a link the
// extension will open. It is NOT the protection — the render path re-checks the
// EXPANDED url on every pass, which is the check that matters, because a
// template can take its scheme from the workflow data (see safeHref). This one
// exists so a bad template is not discovered as a dead button on the page.
function showTemplateVerdict(input: HTMLInputElement, warning: HTMLElement): void {
    const safe = templateIsSafe(input.value);
    input.classList.toggle('invalid', !safe);
    // aria-invalid too: "the border went dashed" is not available to a screen
    // reader, and this is the only signal the field is not going to work.
    if (safe) input.removeAttribute('aria-invalid');
    else input.setAttribute('aria-invalid', 'true');
    warning.textContent = safe
        ? ''
        : '⚠ Not a link this extension will open. Use an absolute http:// or https:// URL.';
}

function textInput(value: string, placeholder: string, onCommit: (value: string) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    // Commit on 'change' (blur / Enter), not on every keystroke: saving per
    // character would push a settings write — and therefore a re-render of every
    // row in the open tab — for each letter typed into a URL template.
    input.addEventListener('change', () => onCommit(input.value));
    return input;
}

async function showStatus(): Promise<void> {
    const status = $('status');
    const stats = await askActiveTab();

    if (!stats) {
        // Two very different situations produce this one silence, and the order of
        // the sentences below is the whole point.
        //
        // The obvious one is the wrong page. The one that actually gets reported is a
        // Temporal page that was ALREADY OPEN when the extension was installed or
        // reloaded: Chrome injects content scripts at page load and does not go back
        // and inject them into existing tabs, so the tab keeps running without one and
        // every feature is simply absent. Measured on Cloud 2.53.3 with the same
        // build, same page, same activity panel — loaded before the navigation the
        // page carries a link bar and a per-activity link; loaded afterwards it
        // carries no extension node at all and prints no log line.
        //
        // This message used to lead with "Open a Temporal workflow list", which tells
        // a user who is standing on a workflow page that they are in the wrong place.
        // They are not — they are one reload away. Lead with the fix that is far more
        // likely to be theirs, and say WHY, because "reload and it works" with no
        // reason reads like a flaky extension.
        status.textContent = [
            'No answer from this tab — no content script is running in it.',
            'If this is a Temporal page, reload it. Chrome only injects content scripts into pages loaded after the extension, so a tab that was already open when you installed or reloaded the extension never got one.',
            'If it is not, open https://cloud.temporal.io/… or http://localhost:8233/….',
        ].join('\n');
        return;
    }
    // A workflow's own page is not a failed list page, and saying "no workflow table"
    // there reads as one. It is where the deep links live, so it gets its own answer.
    if (!stats.onListPage && stats.onDetailPage) {
        status.textContent = [
            `On one workflow's own page${stats.namespace ? ` (namespace ${stats.namespace})` : ''}.`,
            `${stats.activitiesKnown} activit${stats.activitiesKnown === 1 ? 'y' : 'ies'} known from the history this page has loaded, ${stats.activityPanelsLinked} activity panel${stats.activityPanelsLinked === 1 ? '' : 's'} linked.`,
            stats.activitiesKnown === 0
                ? 'Nothing observed yet — reload the page. This extension does not fetch the history itself.'
                : 'Open an activity in the timeline to get its links: they are added to the row labelled "Activity Id".',
            // The one state that cannot be seen from the page. At the cap the oldest
            // activities have been dropped, so their panels get no link — identical on
            // screen to a selector that stopped matching. Said here or nowhere.
            stats.activitiesKnown >= MAX_ACTIVITIES
                ? `Only the newest ${MAX_ACTIVITIES} activities are kept, so an early activity on this workflow may get no link at all. That is the cap, not a broken selector.`
                : '',
            stats.linksAdrift
                ? 'The workflow links could not find this page’s own layout and are parked in the bottom-right corner. That is a stale selector, not a missing feature.'
                : '',
        ]
            .filter(Boolean)
            .join('\n');
        return;
    }
    if (!stats.onListPage) {
        status.textContent = `Content script is running${stats.namespace ? ` (namespace ${stats.namespace})` : ''}, but this page has no workflow table.`;
        return;
    }

    const lines = [
        `${stats.rowsSeen} rows in the table, ${stats.rowsMatched} matched to API data.`,
        `${stats.families} famil${stats.families === 1 ? 'y' : 'ies'} with children, ${stats.rowsIndented} indented rows.`,
        // Stated even when both are zero: "this extension asked Temporal about N
        // runs" is the one line here that describes traffic, and a cost that only
        // appears once it is non-zero is a cost nobody looks for.
        `${stats.runsAsked} run${stats.runsAsked === 1 ? '' : 's'} asked about (last event / retries), ${stats.retryBadges} retrying now.`,
    ];
    // Each of these is a different problem wearing the same face.
    if (stats.rowsKnown === 0) {
        lines.push('Nothing observed yet — reload the list page so the extension can see its API call.');
    } else if (stats.rowsSeen > 0 && stats.rowsMatched === 0) {
        lines.push('Rows are on screen but none matched. The API response shape may have changed; check the page console.');
    } else if (stats.families === 0) {
        lines.push('No parent/child pair on this page. Children whose parents are filtered out cannot be grouped.');
    }
    status.textContent = lines.join('\n');
}

// The popup cannot read the page directly — the extension holds no host
// permission — so it asks the content script.
//
// chrome.tabs.query without the "tabs" permission still returns the tab id (it
// withholds url and title, which we do not need). If a Chrome build declines to
// deliver the message without a host grant, this resolves to null and the status
// line says so; it does not ask for a permission to find out.
async function askActiveTab(): Promise<PageStats | null> {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return null;
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'tuis-stats' });
        return (response as PageStats | undefined) ?? null;
    } catch {
        return null;
    }
}

void main();
