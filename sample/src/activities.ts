// Activities. They do nothing but wait — the point of this sample is the SHAPE
// of the execution, not the work.

import { log, sleep } from '@temporalio/activity';

export async function reserveStock(sku: string, quantity: number): Promise<string> {
    log.info('reserving stock', { sku, quantity });
    await sleep(500);
    return `reserved ${quantity} × ${sku}`;
}

export async function chargeCard(orderId: string, amountCents: number): Promise<string> {
    log.info('charging card', { orderId, amountCents });
    await sleep(750);
    return `charged ${(amountCents / 100).toFixed(2)}`;
}

export async function bookCourier(orderId: string): Promise<string> {
    log.info('booking courier', { orderId });
    await sleep(500);
    return `courier booked for ${orderId}`;
}

export async function notifyCustomer(orderId: string, message: string): Promise<string> {
    log.info('notifying customer', { orderId, message });
    await sleep(250);
    return `notified about ${orderId}`;
}

// Fails on demand, so a family with a failure in it can be looked at in the UI.
export async function runFraudCheck(orderId: string, shouldFail: boolean): Promise<string> {
    log.info('running fraud check', { orderId, shouldFail });
    await sleep(400);
    if (shouldFail) throw new Error(`fraud check declined ${orderId}`);
    return `cleared ${orderId}`;
}
