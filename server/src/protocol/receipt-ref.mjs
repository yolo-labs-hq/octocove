export const RECEIPT_PREFIX = 'refs/octocove/receipts/';
export function validReceiptRef(ref) {
    return typeof ref === 'string' && /^refs\/octocove\/receipts\/[a-zA-Z0-9_-]{1,160}$/.test(ref);
}
