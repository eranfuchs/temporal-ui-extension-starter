// Creates a handful of order families, then exits.
//
//   npm start                 # four families, one of them still running
//   npm start -- 12           # twelve
//
// Run it a few times and the workflow list fills with families worth looking at:
// some finished, one failed, one still running — which is what the extension's
// ordering rules were written for.

import { Client, Connection } from '@temporalio/client';

import { order, type OrderOptions } from './workflows';
import { ADDRESS, NAMESPACE, TASK_QUEUE, UI_BASE_URL } from './shared';

const familyCount = Number(process.argv[2] ?? 4);

async function run(): Promise<void> {
    const connection = await Connection.connect({ address: ADDRESS });
    try {
        const client = new Client({ connection, namespace: NAMESPACE });
        // One suffix per batch keeps ids unique across repeated runs without
        // making them unreadable.
        const batch = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(2, 12);

        for (let index = 0; index < familyCount; index++) {
            const orderId = `order-${batch}-${String(index + 1).padStart(2, '0')}`;
            const options: OrderOptions = {
                // The last family lingers, so the list always has a Running row.
                lingerSeconds: index === familyCount - 1 ? 600 : undefined,
                // Every third family fails its fraud check.
                failFraudCheck: index > 0 && index % 3 === 0,
            };
            const handle = await client.workflow.start(order, {
                taskQueue: TASK_QUEUE,
                workflowId: orderId,
                args: [orderId, options],
            });
            console.log(`started ${handle.workflowId} (run ${handle.firstExecutionRunId})`);
        }

        console.log(`\n${familyCount} families started.`);
        console.log(`Now look at ${UI_BASE_URL}/namespaces/${NAMESPACE}/workflows`);
    } finally {
        await connection.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
