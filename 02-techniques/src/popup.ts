// The toolbar popup: the settings UI, and an honest answer to "is it working?".
//
// The status line matters more than it looks. Every silent failure this
// extension can have — wrong page, a filter that returned children whose parents
// are absent, an API URL shape that changed — presents identically as "the tree
// does nothing". Showing rows-seen, rows-matched and families-found separates
// those three cases in one glance.

import { KNOWN_TOKENS, type DeepLinkTemplate } from './deepLink';
import { loadSettings, saveSettings, type Settings } from './settings';

interface PageStats {
    onListPage: boolean;
    namespace: string | null;
    rowsSeen: number;
    rowsMatched: number;
    rowsIndented: number;
    rowsKnown: number;
    families: number;
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
    renderLinks();

    $('add-link').addEventListener('click', () => {
        settings.links = [...settings.links, { label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' }];
        renderLinks();
        void saveSettings({ links: settings.links });
    });

    void showStatus();
}

function bindToggle(key: 'enabled' | 'treeEnabled' | 'linksEnabled'): void {
    const input = $<HTMLInputElement>(key);
    input.checked = settings[key];
    input.addEventListener('change', () => {
        settings[key] = input.checked;
        void saveSettings({ [key]: input.checked });
    });
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

    const label = textInput(link.label, 'Button label', (value) => {
        settings.links[index]!.label = value;
        void saveSettings({ links: settings.links });
    });
    // example.com, not a made-up hostname: it is the reserved documentation
    // domain (RFC 2606), so a placeholder in a public repo can never be read as
    // a real internal address — by a person or by the leak gate.
    const template = textInput(link.urlTemplate, 'https://logs.example.com/?q={workflowId}', (value) => {
        settings.links[index]!.urlTemplate = value;
        void saveSettings({ links: settings.links });
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove this link';
    remove.addEventListener('click', () => {
        settings.links = settings.links.filter((_, i) => i !== index);
        renderLinks();
        void saveSettings({ links: settings.links });
    });

    row.append(label, template, remove);
    return row;
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
        // This is the expected answer on any page the content script does not run
        // on, and it is also what a tab that has not been reloaded since the
        // extension was installed looks like.
        status.textContent =
            'No answer from this tab.\nOpen a Temporal workflow list — https://cloud.temporal.io/… or http://localhost:8233/… — and reload it once after installing.';
        return;
    }
    if (!stats.onListPage) {
        status.textContent = `Content script is running${stats.namespace ? ` (namespace ${stats.namespace})` : ''}, but this page has no workflow table.`;
        return;
    }

    const lines = [
        `${stats.rowsSeen} rows in the table, ${stats.rowsMatched} matched to API data.`,
        `${stats.families} famil${stats.families === 1 ? 'y' : 'ies'} with children, ${stats.rowsIndented} indented rows.`,
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
