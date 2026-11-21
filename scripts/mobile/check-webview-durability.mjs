import { openPrototypeWebView } from './webview-connection.mjs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { serial: { type: 'string' }, output: { type: 'string' } } });
if (!values.serial || !values.output) throw new Error('Use --serial DEVICE --output NEW_FILE');
const pkg = 'org.askarys.hrttracker.spike';
const adb = (...args) => execFileSync('adb', ['-s', values.serial, ...args], { encoding: 'utf8', timeout: 30_000 });
let connection;
const connect = async () => {
    await connection?.close();
    connection = await openPrototypeWebView(values.serial);
    return connection.page;
};
const observations = [];
try {
    // The delayed control diagnoses async flushing. It is never a durability
    // contract or a proposed production workaround.
    for (const waitMs of [0, 8000]) {
        let page = await connect();
        const sentinel = randomUUID();
        const acknowledged = await page.evaluate(value => {
            localStorage.setItem('feasibility-write-proof', value);
            return localStorage.getItem('feasibility-write-proof') === value;
        }, sentinel);
        if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
        adb('shell', 'am', 'force-stop', pkg);
        page = await connect();
        const survived = await page.evaluate(
            value => localStorage.getItem('feasibility-write-proof') === value,
            sentinel,
        );
        observations.push({ waitMs, acknowledged, survived });
    }
    const report = {
        durableAcknowledgement: observations.every(value => value.acknowledged && value.survived),
        observations,
    };
    writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.durableAcknowledgement) process.exitCode = 1;
} finally {
    await connection?.close();
}
