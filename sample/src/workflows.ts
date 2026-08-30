// Workflows whose only job is to produce a hierarchy worth drawing.
//
//   order
//   ├─ payment
//   └─ fulfilment
//      └─ shipment          ← a grandchild, so the tree is three levels deep
//
// Three levels is the minimum that exercises every connector the extension can
// draw: the vertical carried through a level that still has siblings ('cont'),
// and the blank column under a level that does not ('pad').

import { executeChild, proxyActivities, sleep, workflowInfo } from '@temporalio/workflow';

import type * as activities from './activities';

const { reserveStock, chargeCard, bookCourier, notifyCustomer, runFraudCheck } = proxyActivities<
    typeof activities
>({
    startToCloseTimeout: '1 minute',
    // One retry only: a sample that retries a deliberate failure for ten minutes
    // teaches the wrong lesson about how long to wait for a screenshot.
    retry: { maximumAttempts: 2 },
});

export interface OrderOptions {
    // Hold the family open for this long, so the list has something Running in it
    // and the "families with a running member sort first" rule is visible.
    lingerSeconds?: number;
    // Fail the fraud check, so a family with a failure can be inspected.
    failFraudCheck?: boolean;
}

export async function order(orderId: string, options: OrderOptions = {}): Promise<string> {
    const { runId } = workflowInfo();

    // Both children run at once: a real order does not wait for the courier to be
    // booked before charging the card, and concurrent children are what makes the
    // sibling connectors interesting.
    const [payment, fulfilment] = await Promise.all([
        executeChild(paymentWorkflow, {
            workflowId: `${orderId}-payment`,
            args: [orderId, options.failFraudCheck ?? false],
        }),
        executeChild(fulfilmentWorkflow, {
            workflowId: `${orderId}-fulfilment`,
            args: [orderId, options],
        }),
    ]);

    return `order ${orderId} (run ${runId}): ${payment}; ${fulfilment}`;
}

export async function paymentWorkflow(orderId: string, failFraudCheck: boolean): Promise<string> {
    const cleared = await runFraudCheck(orderId, failFraudCheck);
    const charged = await chargeCard(orderId, 4999);
    return `${cleared}, ${charged}`;
}

export async function fulfilmentWorkflow(orderId: string, options: OrderOptions): Promise<string> {
    const reserved = await reserveStock('SKU-STARTER-KIT', 1);
    const shipment = await executeChild(shipmentWorkflow, {
        workflowId: `${orderId}-shipment`,
        args: [orderId],
    });

    if (options.lingerSeconds) {
        // A workflow sleeping is a workflow the UI shows as Running, with nothing
        // consuming a worker slot while it waits.
        await sleep(`${options.lingerSeconds} seconds`);
    }

    return `${reserved}, ${shipment}`;
}

export async function shipmentWorkflow(orderId: string): Promise<string> {
    const courier = await bookCourier(orderId);
    const notified = await notifyCustomer(orderId, 'your order is on its way');
    return `${courier}, ${notified}`;
}
