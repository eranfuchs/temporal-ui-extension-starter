// The worker. Point it at a local dev server:
//
//   temporal server start-dev          # in one terminal
//   npm run worker                     # in this directory, in another
//   npm start                          # in a third, to create some workflows
//
// Talks to 127.0.0.1:7233 only. Nothing here reaches a network, holds a
// credential, or is aware that Temporal Cloud exists.

import { NativeConnection, Worker } from '@temporalio/worker';

import * as activities from './activities';
import { ADDRESS, NAMESPACE, TASK_QUEUE } from './shared';

async function run(): Promise<void> {
    const connection = await NativeConnection.connect({ address: ADDRESS });
    try {
        const worker = await Worker.create({
            connection,
            namespace: NAMESPACE,
            taskQueue: TASK_QUEUE,
            // A resolved path, not an import: the SDK bundles workflow code into
            // its own deterministic sandbox, so it needs the file rather than the
            // already-loaded module.
            workflowsPath: require.resolve('./workflows'),
            activities,
        });
        console.log(`worker polling ${NAMESPACE}/${TASK_QUEUE} at ${ADDRESS}`);
        await worker.run();
    } finally {
        await connection.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
