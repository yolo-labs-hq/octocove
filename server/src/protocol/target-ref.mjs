export function validTargetRef(ref) {
    return typeof ref === 'string' && ref.startsWith('refs/heads/') &&
        ref.length > 11 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) &&
        !ref.includes('..') && !ref.includes('@{') && !ref.endsWith('.') &&
        ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
}
