import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const ignored = new Set(['.git', 'node_modules', 'playwright-report', 'test-results']);
const checkedExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.yml', '.yaml']);

// Deep host imports are confined to one file. Raw HTML insertion is banned outright:
// post bodies are model output and render as text nodes, never as markup.
const HOST_IMPORT_FILE = path.join(root, 'src', 'api.js');
const JAVASCRIPT_TOKEN = /(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const HOST_IMPORT = /\b(?:import\s*(?:\(\s*)?|(?:import|export)\s*[^;]*?\bfrom\s*)['"`](?:\/scripts\/|(?:\.\.\/)+(?:script|scripts)[./])/;
const HTML_ASSIGNMENT = /(?:\.\s*(?:innerHTML|outerHTML)\b|\[\s*(['"`])(?:innerHTML|outerHTML)\1\s*\])\s*(?:(?:\*\*|>>>|&&|\|\||\?\?|<<|>>|[+\-*/%&|^])?=)(?!=|>)/;
const INSERT_ADJACENT_HTML = /(?:\.\s*insertAdjacentHTML\b|\[\s*(['"`])insertAdjacentHTML\1\s*\])\s*(?:\?\.\s*)?\(/;

const errors = [];

async function filesBelow(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name)) {
            continue;
        }
        const location = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            result.push(...await filesBelow(location));
        } else if (checkedExtensions.has(path.extname(entry.name))) {
            result.push(location);
        }
    }
    return result;
}

function withoutComments(source) {
    return source.replace(JAVASCRIPT_TOKEN, token => token.startsWith('/') ? ' ' : token);
}

function codeOnly(source) {
    return source.replace(JAVASCRIPT_TOKEN, ' ');
}

for (const file of await filesBelow(root)) {
    const relative = path.relative(root, file);
    const content = await readFile(file, 'utf8');
    if (content.includes('\r')) {
        errors.push(`${relative}: use LF line endings`);
    }
    if (!content.endsWith('\n')) {
        errors.push(`${relative}: missing final newline`);
    }
    content.split('\n').forEach((line, index) => {
        if (/[ \t]+$/.test(line)) {
            errors.push(`${relative}:${index + 1}: trailing whitespace`);
        }
    });
    if (path.extname(file) === '.json') {
        try {
            JSON.parse(content);
        } catch (error) {
            errors.push(`${relative}: invalid JSON (${error.message})`);
        }
    }
    if (path.extname(file) === '.js') {
        const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        if (check.status !== 0) {
            errors.push(`${relative}: ${check.stderr.trim() || 'syntax check failed'}`);
        }
    }
}

const packageData = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
if (packageData.version !== manifest.version) {
    errors.push('package.json and manifest.json versions differ');
}
if (packageData.license !== manifest.license) {
    errors.push('package.json and manifest.json licenses differ');
}

const entrySource = codeOnly(await readFile(path.join(root, manifest.js), 'utf8'));
for (const hook of Object.values(manifest.hooks ?? {})) {
    if (!new RegExp(`export\\s+(?:async\\s+)?function\\s+${hook}\\b`).test(entrySource)) {
        errors.push(`${manifest.js} does not export manifest hook ${hook}`);
    }
}

for (const file of (await filesBelow(path.join(root, 'src'))).filter(name => name.endsWith('.js'))) {
    const relative = path.relative(root, file);
    const raw = await readFile(file, 'utf8');
    const source = withoutComments(raw);
    if (file !== HOST_IMPORT_FILE && HOST_IMPORT.test(source)) {
        errors.push(`${relative}: deep host imports belong in src/api.js`);
    }
    // Scan raw text: the lightweight comment stripper cannot distinguish // inside regex literals.
    if (HTML_ASSIGNMENT.test(raw) || INSERT_ADJACENT_HTML.test(raw)) {
        errors.push(`${relative}: render text with textContent - post bodies are model output`);
    }
}

if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
} else {
    console.log('Lint checks passed.');
}
